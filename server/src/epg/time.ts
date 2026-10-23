/**
 * XMLTV times look like "20261020193000 +0200". The offset is optional (then UTC is assumed),
 * and some feeds drop the seconds or the space before the offset.
 * Returns Unix seconds, or null when the value can't be read.
 */
export function parseXmltvTime(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z|UTC|GMT)?/i.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", tz] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (Number.isNaN(ms)) return null;
  if (tz && /^[+-]/.test(tz)) {
    const digits = tz.replace(":", "");
    const sign = digits[0] === "-" ? -1 : 1;
    const offsetMinutes = sign * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
    ms -= offsetMinutes * 60_000;
  }
  return Math.floor(ms / 1000);
}

/** Unix seconds -> "YYYYMMDDHHMMSS +0000". */
export function formatXmltvTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
  );
}

export interface EpgWindow {
  from: number;
  to: number;
}

export function epgWindow(days: number, pastDays: number, now = Date.now()): EpgWindow {
  const nowS = Math.floor(now / 1000);
  // Start at midnight UTC of the earliest day so "earlier today" is complete.
  const dayStart = nowS - (nowS % 86_400);
  return { from: dayStart - pastDays * 86_400, to: nowS + days * 86_400 };
}
