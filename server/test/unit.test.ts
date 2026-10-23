import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { compileRule } from "../src/filter/channels.js";
import { cleanChannelName, isAllCaps, normalizeName } from "../src/epg/normalize.js";
import { parseXmltv, type XmltvProgramme } from "../src/epg/parse.js";
import { formatXmltvTime, parseXmltvTime } from "../src/epg/time.js";
import { clipOverlaps, dummyProgrammes, xml } from "../src/output/export.js";
import { decodeMaybeBase64, normalizeServerUrl, redact } from "../src/xtream/client.js";

describe("xmltv time", () => {
  it("applies the offset", () => {
    expect(parseXmltvTime("20261020193000 +0200")).toBe(Date.UTC(2026, 9, 20, 17, 30) / 1000);
    expect(parseXmltvTime("20261020193000 -0130")).toBe(Date.UTC(2026, 9, 20, 21, 0) / 1000);
  });
  it("assumes UTC without offset and tolerates missing seconds", () => {
    expect(parseXmltvTime("202610201930")).toBe(Date.UTC(2026, 9, 20, 19, 30) / 1000);
  });
  it("rejects garbage", () => {
    expect(parseXmltvTime("tomorrow")).toBeNull();
    expect(parseXmltvTime(undefined)).toBeNull();
  });
  it("round-trips", () => {
    const t = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;
    expect(formatXmltvTime(t)).toBe("20260102030405 +0000");
    expect(parseXmltvTime(formatXmltvTime(t))).toBe(t);
  });
});

describe("cleanChannelName", () => {
  it("removes country prefixes and quality suffixes", () => {
    expect(cleanChannelName("NL 4K-NPO 1")).toBe("NPO 1");
    expect(cleanChannelName("NL-  ZIGGO SPORT 2 4k")).toBe("ZIGGO SPORT 2");
    expect(cleanChannelName("NL 4K- PARAMOUNT NETWORK FHD")).toBe("PARAMOUNT NETWORK");
    expect(cleanChannelName("NL-  Comedy Central extra")).toBe("Comedy Central extra");
    expect(cleanChannelName("UK: BBC One ᴴᴰ")).toBe("BBC One");
    expect(cleanChannelName("|DE| Das Erste HD")).toBe("Das Erste");
  });
  it("leaves names alone that only look like prefixes", () => {
    expect(cleanChannelName("RTL 4")).toBe("RTL 4");
    expect(cleanChannelName("TV ORANJE")).toBe("TV ORANJE");
    expect(cleanChannelName("RTL-Z")).toBe("RTL-Z");
    expect(cleanChannelName("HD")).toBe("HD");
  });
  it("detects all-caps names", () => {
    expect(isAllCaps("RTL CRIME")).toBe(true);
    expect(isAllCaps("NPO 1")).toBe(true);
    expect(isAllCaps("Comedy Central")).toBe(false);
    expect(isAllCaps("24")).toBe(false);
  });
});

describe("normalizeName", () => {
  it("handles prefixes without spaces around the dash", () => {
    expect(normalizeName("NL-  NPO 1")).toBe("npo1");
    expect(normalizeName("NL 4K-NPO 1")).toBe("npo1");
    expect(normalizeName("NPO.1.nl")).toBe("npo1");
  });
  it("strips country prefixes and quality tags", () => {
    expect(normalizeName("UK: BBC One FHD")).toBe("bbcone");
    expect(normalizeName("|DE| Das Erste HD")).toBe("daserste");
    expect(normalizeName("[NL] NPO 1 (backup)")).toBe("npo1");
    expect(normalizeName("BBC One ᴴᴰ")).toBe("bbcone");
  });
  it("treats xmltv ids like names", () => {
    expect(normalizeName("BBCOne.uk")).toBe("bbcone");
  });
  it("keeps timeshift channels apart", () => {
    expect(normalizeName("ITV +1")).not.toBe(normalizeName("ITV"));
    expect(normalizeName("ITV (+1)")).toBe(normalizeName("ITV +1"));
  });
});

describe("rules", () => {
  it("matches substrings case-insensitively with * wildcards", () => {
    expect(compileRule({ pattern: "sport", is_regex: 0 })("Sky SPORTS Main")).toBe(true);
    expect(compileRule({ pattern: "uk:*news", is_regex: 0 })("UK: BBC News")).toBe(true);
    expect(compileRule({ pattern: "a.b", is_regex: 0 })("axb")).toBe(false);
  });
  it("supports regex and survives bad patterns", () => {
    expect(compileRule({ pattern: "^DE:", is_regex: 1 })("DE: ZDF")).toBe(true);
    expect(compileRule({ pattern: "(", is_regex: 1 })("anything")).toBe(false);
  });
});

describe("xtream helpers", () => {
  it("normalises pasted server URLs", () => {
    expect(normalizeServerUrl("provider.tv:8080")).toBe("http://provider.tv:8080");
    expect(normalizeServerUrl("http://provider.tv:8080/player_api.php")).toBe("http://provider.tv:8080");
    expect(normalizeServerUrl("https://provider.tv/panel/")).toBe("https://provider.tv/panel");
  });
  it("decodes base64 EPG text but leaves plain text alone", () => {
    expect(decodeMaybeBase64(Buffer.from("Tagesschau – 20 Uhr").toString("base64"))).toBe("Tagesschau – 20 Uhr");
    expect(decodeMaybeBase64("News")).toBe("News");
    expect(decodeMaybeBase64("Plain title with spaces")).toBe("Plain title with spaces");
  });
  it("redacts credentials", () => {
    expect(redact("http://x/player_api.php?username=bob&password=secret")).toBe("http://x/player_api.php?username=***&password=***");
    expect(redact("http://x/live/bob/secret/1.ts")).toBe("http://x/live/***/***/1.ts");
  });
});

describe("xmltv parser", () => {
  const doc = `<?xml version="1.0"?><tv>
    <channel id="a"><display-name>A &amp; B</display-name><icon src="i.png"/></channel>
    <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="a">
      <title>One &nbsp;Two</title><desc><![CDATA[Some <b>desc</b>]]></desc>
      <category>Sports</category><category>Sports</category>
      <rating><value>PG</value></rating><previously-shown/>
    </programme>
    <programme start="bad" channel="a"><title>skip</title></programme>
    <programme start="20260101010000 +0000" stop="20260101020000 +0000" channel="b"><title>Not wanted</title></programme>
  </tv>`;

  it("reads channels and programmes, skipping unwanted ones", async () => {
    const channels: string[] = [];
    const programmes: XmltvProgramme[] = [];
    const stats = await parseXmltv(Readable.from([doc]), {
      onChannel: (c) => channels.push(`${c.id}:${c.names.join(",")}:${c.icon}`),
      onProgramme: (p) => programmes.push(p),
      wantProgramme: (ch) => ch === "a",
    });
    expect(channels).toEqual(["a:A & B:i.png"]);
    expect(programmes).toHaveLength(1);
    expect(programmes[0]).toMatchObject({
      title: "One  Two".replace(/\s+/g, " "),
      description: "Some <b>desc</b>",
      categories: ["Sports"],
      rating: "PG",
      previouslyShown: true,
    });
    expect(stats.skipped).toBe(2);
  });
});

describe("export helpers", () => {
  it("escapes XML and drops control characters", () => {
    expect(xml(`a & <b> "c"\u0001`)).toBe("a &amp; &lt;b&gt; &quot;c&quot;");
  });
  it("clips overlapping programmes", () => {
    const rows = clipOverlaps([
      { start: 0, stop: 100 },
      { start: 50, stop: 150 },
      { start: 150, stop: 150 },
    ]);
    expect(rows).toEqual([
      { start: 0, stop: 50 },
      { start: 50, stop: 150 },
    ]);
  });
  it("fills the window with aligned placeholder blocks", () => {
    const rows = dummyProgrammes({ name: "X" }, 3600, 3 * 3600, 60);
    expect(rows.map((r) => r.start)).toEqual([3600, 7200]);
    expect(rows[0].title).toBe("X");
  });
});
