import crypto from "node:crypto";
import { getSetting, setSetting, type DB } from "../db.js";

export const SESSION_COOKIE = "channelarr_session";
const SESSION_DAYS = 30;

export function hasAdminPassword(db: DB): boolean {
  return Boolean(getSetting(db, "admin_password"));
}

export function setAdminPassword(db: DB, password: string) {
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  setSetting(db, "admin_password", `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
}

export function verifyAdminPassword(db: DB, password: string): boolean {
  const stored = getSetting(db, "admin_password");
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function createSession(db: DB): { token: string; maxAge: number } {
  const token = crypto.randomBytes(32).toString("hex");
  const maxAge = SESSION_DAYS * 86_400;
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token, expires) VALUES (?, ?)").run(hashToken(token), Date.now() + maxAge * 1000);
  return { token, maxAge };
}

export function validSession(db: DB, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare("SELECT expires FROM sessions WHERE token = ?").get(hashToken(token)) as { expires: number } | undefined;
  return Boolean(row && row.expires > Date.now());
}

export function deleteSession(db: DB, token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
}

/** Sessions are stored hashed so a copied database doesn't hand out logins. */
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
