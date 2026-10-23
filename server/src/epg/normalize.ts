// Quality and codec tags that providers glue onto channel names but EPG feeds leave out.
const NOISE_TOKENS = new Set([
  "hd", "fhd", "uhd", "sd", "hq", "lq", "4k", "8k", "hevc", "h264", "h265", "x264", "x265",
  "1080", "1080p", "1080i", "720", "720p", "576p", "480p", "2160p", "50fps", "60fps", "fps",
  "raw", "backup", "vip",
]);

const QUALITY = String.raw`(?:4k|8k|uhd|fhd|hd|sd|hevc|h\.?26[45]|50fps|60fps|1080p|720p)`;
// "NL-", "NL 4K-", "UK: ", "DE - ", "US |", and bracketed "|NL|", "[NL]", "(NL)".
// Only two-letter codes are stripped when followed by a separator, so names like "RTL-Z" survive.
const PREFIX_RE = new RegExp(String.raw`^\s*(?:[|[(]\s*[a-z]{2,3}\s*[|\])]|[a-z]{2}(?:\s+${QUALITY})?\s*[-:|])\s*`, "i");
const SUFFIX_RE = new RegExp(String.raw`(?:\s*[-|]?\s*\b${QUALITY}\b|\s*[ᴴᴰᵁˢ]+)+\s*$`, "iu");

/**
 * Display name without country prefix and quality suffix: "NL 4K-NPO 1" -> "NPO 1",
 * "NL-  ZIGGO SPORT 2 4k" -> "ZIGGO SPORT 2". Returns the input unchanged if nothing would be left.
 */
export function cleanChannelName(input: string): string {
  const cleaned = input.replace(PREFIX_RE, "").replace(SUFFIX_RE, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || input.trim();
}

/** True for names written entirely in capitals ("RTL CRIME"), which read better in the guide's spelling. */
export function isAllCaps(name: string): boolean {
  return /\p{Lu}{2}/u.test(name) && !/\p{Ll}/u.test(name);
}

/**
 * Turns "UK: BBC One ᴴᴰ", "|DE| Das Erste FHD" and "bbc.one.uk" into comparable keys
 * ("bbcone", "daserste", "bbcone"). "+1" timeshift channels keep their suffix so they stay distinct.
 */
export function normalizeName(input: string): string {
  let s = cleanChannelName(input.normalize("NFKC")).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  // Older style prefixes with longer codes: "UHD: ", "EXYU | ".
  s = s.replace(/^\s*[a-z]{3,4}(?:\s*[:|]|\s+-\s+)\s*/, "");
  // Trailing ".uk" style country suffix used in XMLTV channel ids.
  s = s.replace(/\.[a-z]{2}$/, "");
  // Bracketed extras: "(backup)", "[multi-audio]". Keep "(+1)".
  s = s.replace(/[[(](?!\s*\+\d)[^\])]*[\])]/g, " ");
  s = s.replace(/\+\s*(\d)/g, " plus$1 ");
  s = s.replace(/&/g, " and ");
  const tokens = s
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !NOISE_TOKENS.has(t));
  return tokens.join("");
}
