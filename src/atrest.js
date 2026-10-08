// Conversation content is sealed before it touches disk: an AES-256-GCM wrapper replaces each
// sensitive string in the store snapshot, so data/store.json alone no longer reads as plain text.
// The key never lives in the snapshot. Sources, in order:
//   1. CUE_TRANSCRIPT_KEY  — 32 bytes as 64 hex chars or base64 (containers, CI, explicit setup)
//   2. macOS Keychain      — a "cue-transcript-key" generic password, created on first real run
//   3. .cue-atrest-key     — a 0600 key file next to the store (non-macOS fallback)
// Tests (NODE_TEST_CONTEXT) always use the key file so they never touch the user's keychain.
// If no key can be established the caller must refuse to persist conversation content.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const SERVICE = "cue-transcript-key";
const ACCOUNT = "cue-server";
const inTests = Boolean(process.env.NODE_TEST_CONTEXT);

export function loadAtRestKey(storeFile) {
  const fromEnv = parseKey(process.env.CUE_TRANSCRIPT_KEY);
  if (fromEnv) return fromEnv;
  if (!storeFile) return null;
  if (process.platform === "darwin" && !inTests) return keychainKey();
  return keyFileKey(join(dirname(storeFile), ".cue-atrest-key"));
}

function parseKey(value) {
  if (!value) return null;
  const raw = /^[0-9a-fA-F]{64}$/.test(value.trim()) ? Buffer.from(value.trim(), "hex") : Buffer.from(value, "base64");
  if (raw.length !== 32) throw new Error("CUE_TRANSCRIPT_KEY must be 32 bytes (64 hex chars or base64)");
  return raw;
}

function keychainKey() {
  try {
    const found = execFileSync("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"], { encoding: "utf8" }).trim();
    const key = parseKey(found);
    if (key) return key;
  } catch { /* not present yet */ }
  const key = randomBytes(32);
  execFileSync("security", ["add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", key.toString("hex"), "-U"]);
  return key;
}

function keyFileKey(path) {
  try {
    if (existsSync(path)) {
      // Tighten a restored or manually provisioned key: the documented guarantee is 0600.
      chmodSync(path, 0o600);
      return parseKey(readFileSync(path, "utf8"));
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return parseKey(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`[atrest] no key available (${error.message}); conversation content will not be persisted`);
    return null;
  }
}

// "cue1.<base64(iv[12] | tag[16] | ciphertext)>"
export function sealString(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `cue1.${sealed.toString("base64")}`;
}

export function openString(key, sealed) {
  const raw = Buffer.from(sealed.slice(5), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const isSealed = (value) => typeof value === "string" && value.startsWith("cue1.");
