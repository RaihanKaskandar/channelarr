import fs from "node:fs";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { SaxesParser } from "saxes";
import { parseXmltvTime } from "./time.js";

export interface XmltvChannel {
  id: string;
  names: string[];
  icon: string | null;
}

export interface XmltvProgramme {
  channel: string;
  start: number;
  stop: number;
  title: string;
  subTitle: string | null;
  description: string | null;
  categories: string[];
  episodeNums: { system: string | null; value: string }[];
  icon: string | null;
  rating: string | null;
  isNew: boolean;
  previouslyShown: boolean;
}

export interface ParseHandlers {
  onChannel?: (channel: XmltvChannel) => void;
  onProgramme?: (programme: XmltvProgramme) => void;
  /** Skip programmes cheaply before their children are collected. */
  wantProgramme?: (channelId: string, start: number, stop: number) => boolean;
}

export interface ParseStats {
  channels: number;
  programmes: number;
  skipped: number;
  errors: number;
}

/** Opens a cached guide file, transparently gunzipping it when it starts with the gzip magic bytes. */
export function openGuideFile(file: string): Readable {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const raw = fs.createReadStream(file);
  return head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
}

// Entities that show up in real-world feeds even though XML doesn't define them.
const EXTRA_ENTITIES: Record<string, string> = {
  nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", eacute: "é", egrave: "è", agrave: "à",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ccedil: "ç",
  euro: "€", pound: "£", deg: "°", middot: "·", laquo: "«", raquo: "»",
};

export async function parseXmltv(input: Readable, handlers: ParseHandlers): Promise<ParseStats> {
  const stats: ParseStats = { channels: 0, programmes: 0, skipped: 0, errors: 0 };
  const parser = new SaxesParser({ xmlns: false });
  Object.assign((parser as unknown as { ENTITIES: Record<string, string> }).ENTITIES ?? {}, EXTRA_ENTITIES);

  let channel: XmltvChannel | null = null;
  let programme: XmltvProgramme | null = null;
  let skipping = false;
  let text = "";
  let textTarget: string | null = null;
  let attrs: Record<string, string> = {};
  let ratingDepth = false;

  parser.on("error", () => {
    stats.errors++;
  });

  parser.on("opentag", (tag) => {
    const name = tag.name;
    const a = tag.attributes as Record<string, string>;
    if (name === "channel" && !programme) {
      channel = { id: (a.id ?? "").trim(), names: [], icon: null };
      return;
    }
    if (name === "programme") {
      const start = parseXmltvTime(a.start);
      const stop = parseXmltvTime(a.stop);
      const ch = (a.channel ?? "").trim();
      if (start == null || !ch) {
        skipping = true;
        stats.skipped++;
        return;
      }
      // Some feeds omit stop; treat it as 30 minutes, it will be clipped to the next start on export.
      const end = stop ?? start + 1800;
      if (handlers.wantProgramme && !handlers.wantProgramme(ch, start, end)) {
        skipping = true;
        stats.skipped++;
        return;
      }
      programme = {
        channel: ch, start, stop: end, title: "", subTitle: null, description: null, categories: [],
        episodeNums: [], icon: null, rating: null, isNew: false, previouslyShown: false,
      };
      return;
    }
    if (skipping) return;
    if (channel) {
      if (name === "display-name") startText(name);
      else if (name === "icon" && a.src && !channel.icon) channel.icon = a.src;
      return;
    }
    if (programme) {
      switch (name) {
        case "title":
        case "sub-title":
        case "desc":
        case "category":
        case "episode-num":
          attrs = a;
          startText(name);
          break;
        case "rating":
          ratingDepth = true;
          break;
        case "value":
          if (ratingDepth) startText("rating-value");
          break;
        case "icon":
          if (a.src && !programme.icon) programme.icon = a.src;
          break;
        case "new":
          programme.isNew = true;
          break;
        case "previously-shown":
          programme.previouslyShown = true;
          break;
      }
    }
  });

  parser.on("text", (t) => {
    if (textTarget) text += t;
  });
  parser.on("cdata", (t) => {
    if (textTarget) text += t;
  });

  parser.on("closetag", (tag) => {
    const name = tag.name;
    if (name === "programme") {
      if (programme && !skipping && programme.title) {
        stats.programmes++;
        handlers.onProgramme?.(programme);
      }
      programme = null;
      skipping = false;
      return;
    }
    if (name === "channel" && channel && !programme) {
      if (channel.id) {
        stats.channels++;
        handlers.onChannel?.(channel);
      }
      channel = null;
      return;
    }
    if (name === "rating") ratingDepth = false;
    if (!textTarget || (textTarget !== name && !(textTarget === "rating-value" && name === "value"))) return;
    const value = text.replace(/\s+/g, " ").trim();
    const target = textTarget;
    textTarget = null;
    text = "";
    if (!value) return;
    if (channel) {
      if (target === "display-name") channel.names.push(value);
      return;
    }
    if (!programme) return;
    switch (target) {
      case "title":
        if (!programme.title) programme.title = value;
        break;
      case "sub-title":
        programme.subTitle ??= value;
        break;
      case "desc":
        programme.description ??= value;
        break;
      case "category":
        if (!programme.categories.includes(value)) programme.categories.push(value);
        break;
      case "episode-num":
        programme.episodeNums.push({ system: attrs.system ?? null, value });
        break;
      case "rating-value":
        programme.rating ??= value;
        break;
    }
  });

  function startText(target: string) {
    textTarget = target;
    text = "";
  }

  input.setEncoding("utf8");
  for await (const chunk of input) {
    parser.write(chunk as string);
  }
  parser.close();
  return stats;
}
