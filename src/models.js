// Local models: which vision models fit this Mac, where their files are, and downloading them from
// Hugging Face with progress Setup can show. A model is a GGUF file plus the vision projector
// (mmproj) that lets it see the screenshot; without the projector it answers blind.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { once } from "node:events";
import { config } from "./config.js";

const GB = 1e9;

// Measured with scripts/eval-context.mjs (10 screen + meeting questions, fixture invoice and code)
// on an M3 Pro with the macOS screen-text reader on; "not measured" means exactly that.
export const catalogue = [
  {
    id: "qwen3-vl-4b", label: "Qwen3-VL 4B", repo: "Qwen/Qwen3-VL-4B-Instruct-GGUF",
    file: "Qwen3VL-4B-Instruct-Q4_K_M.gguf", mmproj: "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
    sizeGb: 2.95, minRamGb: 12, quality: "20/20 on Cue's screen and meeting eval; first word ~2-3 s on an M3 Pro",
  },
  {
    id: "qwen3-vl-2b", label: "Qwen3-VL 2B", repo: "Qwen/Qwen3-VL-2B-Instruct-GGUF",
    file: "Qwen3VL-2B-Instruct-Q4_K_M.gguf", mmproj: "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf",
    sizeGb: 1.56, minRamGb: 8, quality: "17/20 on Cue's eval: misreads more numbers; for 8 GB Macs",
  },
  {
    id: "qwen3-vl-8b", label: "Qwen3-VL 8B", repo: "Qwen/Qwen3-VL-8B-Instruct-GGUF",
    file: "Qwen3VL-8B-Instruct-Q4_K_M.gguf", mmproj: "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
    sizeGb: 5.78, minRamGb: 24, quality: "Larger and slower; not measured by Cue",
  },
];
export const defaultModelId = "qwen3-vl-4b";

// The model for this Mac's memory: the biggest measured one that leaves room for everything else.
export function recommendedModel(ramGb = totalmem() / 2 ** 30) {
  return ramGb >= 12 ? "qwen3-vl-4b" : "qwen3-vl-2b";
}

export function modelsDir() {
  return process.env.CUE_MODELS_DIR || join(config.dataFile ? dirname(config.dataFile) : "data", "models");
}

// Speech: whisper.cpp's large-v3-turbo, kept where earlier versions of Cue downloaded it.
export const whisperModel = {
  path: process.env.WHISPER_MODEL || join(homedir(), ".cache", "whisper", "ggml-large-v3-turbo.bin"),
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  sizeGb: 1.62,
};

// A saved choice is a catalogue id, { repo, file, mmproj } from Hugging Face, or { path, mmproj }
// on disk. Returns the files it needs, each with where it is (or will be) and whether it is there.
export function resolveModel(choice = defaultModelId) {
  if (typeof choice === "string") {
    const entry = catalogue.find((model) => model.id === choice) || catalogue.find((model) => model.id === defaultModelId);
    choice = { repo: entry.repo, file: entry.file, mmproj: entry.mmproj, label: entry.label };
  }
  if (choice.path) {
    return { label: choice.label || basename(choice.path), files: [local(choice.path, "model"), ...(choice.mmproj ? [local(choice.mmproj, "mmproj")] : [])] };
  }
  const files = [hubFile(choice.repo, choice.file, "model"), ...(choice.mmproj ? [hubFile(choice.repo, choice.mmproj, "mmproj")] : [])];
  return { label: choice.label || `${choice.repo.split("/").pop()} · ${choice.file}`, repo: choice.repo, files };
}

function local(path, role) {
  return { role, path, present: existsSync(path) };
}

function hubFile(repo, file, role) {
  const cached = hubCache(repo, file);
  const path = cached || join(modelsDir(), repo.replace("/", "--"), file);
  return { role, repo, file, path, url: `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`, present: existsSync(path) };
}

// llama.cpp's -hf and the huggingface_hub library keep files in ~/.cache/huggingface/hub; reuse a
// copy already there instead of downloading gigabytes again.
function hubCache(repo, file) {
  const snapshots = join(process.env.HF_HUB_CACHE || join(homedir(), ".cache", "huggingface", "hub"), `models--${repo.replace("/", "--")}`, "snapshots");
  try {
    for (const snapshot of readdirSync(snapshots)) {
      const path = join(snapshots, snapshot, file);
      if (existsSync(path)) return path;
    }
  } catch {}
  return null;
}

// What a Hugging Face repo offers: its GGUF weights by quantization, and its vision projectors.
export async function listRepo(repo) {
  repo = String(repo || "").trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/(tree|blob|resolve)\/.*$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: "Enter a Hugging Face repo as owner/name, e.g. Qwen/Qwen3-VL-4B-Instruct-GGUF." };
  let response;
  try {
    response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, { headers: hubAuth(), signal: AbortSignal.timeout(10000) });
  } catch (error) {
    return { ok: false, error: `Could not reach Hugging Face (${error.cause?.code || error.name}).` };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, error: `${repo} needs a Hugging Face login; set HF_TOKEN before starting Cue, or pick a public repo.` };
  if (response.status === 404) return { ok: false, error: `${repo} does not exist on Hugging Face.` };
  if (!response.ok) return { ok: false, error: `Hugging Face answered ${response.status}.` };
  const files = (await response.json()).filter((entry) => entry.type === "file" && entry.path.endsWith(".gguf"));
  const projectors = files.filter((entry) => /mmproj/i.test(entry.path)).map(toEntry);
  const weights = files.filter((entry) => !/mmproj/i.test(entry.path)).map(toEntry);
  if (!weights.length) return { ok: false, error: `${repo} has no GGUF files. Cue runs GGUF models (llama.cpp); look for a repo ending in -GGUF.` };
  return { ok: true, repo, weights, projectors };
}

const toEntry = (entry) => ({ file: entry.path, sizeGb: Math.round(((entry.lfs?.size ?? entry.size) / GB) * 100) / 100 });
const hubAuth = () => (process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {});

// ---- downloads ----------------------------------------------------------------------------------
// One download at a time; Setup polls its progress. Files arrive as <name>.part and are renamed only
// when complete, and a .part left by a cancelled or crashed run is resumed with a Range request.
let job = null;

export function downloadStatus() {
  if (!job) return { state: "idle" };
  const { state, label, error, files } = job;
  const done = files.reduce((sum, file) => sum + file.done, 0);
  const total = files.reduce((sum, file) => sum + (file.total || 0), 0);
  return { state, label, error, done, total };
}

export function cancelDownload() {
  if (job?.state === "downloading") job.abort.abort();
}

// curl must not outlive the server: a curl left appending to a .part while the next run resumes the
// same .part writes the bytes twice. Every exit takes the running download down with it.
let curlChild = null;
process.on("exit", () => curlChild?.kill("SIGTERM"));

// `items` are { url, path, sizeGb? }; resolves when finished, failed or cancelled.
export function startDownload(label, items, onDone = () => {}) {
  if (job?.state === "downloading") return downloadStatus();
  const needed = items.reduce((sum, item) => sum + (item.sizeGb || 0) * GB, 0);
  const dir = dirname(items[0].path);
  mkdirSync(dir, { recursive: true });
  const free = freeBytes(dir);
  if (free !== null && needed && free < needed + GB) {
    job = { state: "error", label, error: `Not enough disk space: needs ${(needed / GB).toFixed(1)} GB, ${(free / GB).toFixed(1)} GB free.`, files: [] };
    return downloadStatus();
  }
  job = { state: "downloading", label, error: null, abort: new AbortController(), files: items.map((item) => ({ ...item, done: 0, total: item.sizeGb ? item.sizeGb * GB : 0 })) };
  const current = job;
  (async () => {
    try {
      for (const file of current.files) await fetchFile(file, current.abort.signal);
      current.state = "done";
    } catch (error) {
      current.state = current.abort.signal.aborted ? "cancelled" : "error";
      current.error = current.state === "error" ? error.message : null;
    }
    onDone(current.state);
  })();
  return downloadStatus();
}

// curl, not fetch: from Hugging Face's CDN curl (HTTP/2) measured 1.4-2.1 MB/s where Node's fetch got
// 0.25 MB/s on the same connection, and it resumes a .part with -C - on its own. Progress is the
// .part file's size; the total comes from a HEAD request.
async function fetchFile(file, signal) {
  if (existsSync(file.path)) { file.done = file.total = statSync(file.path).size; return; }
  mkdirSync(dirname(file.path), { recursive: true });
  const part = `${file.path}.part`;
  try { file.done = statSync(part).size; } catch {}   // resuming: progress starts where the last run stopped
  try {
    const head = await fetch(file.url, { method: "HEAD", headers: hubAuth(), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (head.status === 401 || head.status === 403) throw new Error("This file needs a Hugging Face login; set HF_TOKEN before starting Cue.");
    if (!head.ok) throw new Error(`Download of ${basename(file.path)} failed: ${head.status}.`);
    file.total = Number(head.headers.get("content-length")) || file.total;
  } catch (error) {
    if (signal.aborted || error.message.startsWith("Download") || error.message.startsWith("This file")) throw error;
    throw new Error(`Could not reach ${new URL(file.url).host} (${error.cause?.code || error.name}).`);
  }
  // Headers come in on stdin so a Hugging Face token never shows in the process list.
  const curl = spawn("curl", ["-fsSL", "--retry", "3", "-C", "-", "-H", "@-", "-o", part, file.url], { stdio: ["pipe", "ignore", "pipe"] });
  curlChild = curl;
  curl.stdin.end(process.env.HF_TOKEN ? `Authorization: Bearer ${process.env.HF_TOKEN}\n` : "");
  let stderr = "";
  curl.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-400); });
  const onAbort = () => curl.kill("SIGTERM");
  signal.addEventListener("abort", onAbort);
  const timer = setInterval(() => { try { file.done = statSync(part).size; } catch {} }, 500);
  const [code] = await once(curl, "exit").finally(() => { clearInterval(timer); signal.removeEventListener("abort", onAbort); curlChild = null; });
  if (signal.aborted) throw new Error("cancelled");
  try { file.done = statSync(part).size; } catch {}
  if (code !== 0) throw new Error(`Download of ${basename(file.path)} failed: ${stderr.trim().split("\n").pop() || `curl exit ${code}`}.`);
  if (file.total && file.done < file.total) throw new Error(`Download of ${basename(file.path)} stopped early; Download resumes it.`);
  // Bigger than the server says means two writers appended to it: never let that pass for a model.
  if (file.total && file.done !== file.total) {
    try { unlinkSync(part); } catch {}
    throw new Error(`Download of ${basename(file.path)} came out the wrong size and was deleted; download it again.`);
  }
  renameSync(part, file.path);
}

function freeBytes(dir) {
  try { const stats = statfsSync(dir); return stats.bavail * stats.bsize; } catch { return null; }
}
