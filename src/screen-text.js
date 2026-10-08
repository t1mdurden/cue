// The text on a screenshot, read by bin/screen-text (macOS Vision, on-device; built from
// native/screen-text.swift by `npm run app`). The local model sees a screenshot at its 512-token
// budget, where 15 px text is ~7 px: it read 201.90 as 201.00 and Decimal('0.0') as 0.01 in
// scripts/eval-context.mjs. Vision reads the full capture exactly, so the local model's turn gets
// both the picture and the characters. No helper (Linux, Docker, no Xcode tools): no text, same as before.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const helper = process.env.CUE_SCREEN_TEXT ?? join(process.cwd(), "bin", "screen-text");
export const available = Boolean(helper) && existsSync(helper);
const TIMEOUT_MS = 3000;     // first run of the day loads Vision's model (~1.8 s); warm is ~0.4 s
const MAX_CHARS = 8000;      // a full dense screen is ~2k; bound the tokens a pathological one adds

// Resolves to the screen's text, or "" when the helper is missing, fails, or is too slow. Never rejects.
export function readScreenText(image) {
  if (!available) return Promise.resolve("");
  return new Promise((resolve) => {
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(""); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim().slice(0, MAX_CHARS) : ""); });
    child.stdin.on("error", () => {});
    child.stdin.end(image);
  });
}
