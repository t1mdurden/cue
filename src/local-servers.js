// The model servers Cue runs on this Mac: llama-server for answers (only with the local backend) and
// whisper-server for speech (only with local transcription). The app server starts, restarts and
// stops them, so a choice made in Setup or Settings takes effect without relaunching Cue, and a
// missing model shows up in Setup instead of a launcher waiting silently on a 3 GB download.
// CUE_LLM_BASE_URL / CUE_ASR_BASE_URL mean someone else runs that server (Docker, scripts): Cue
// then starts nothing for it.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { config, isMock } from "./config.js";
import { resolveModel, whisperModel } from "./models.js";
import { available as hasScreenText } from "./screen-text.js";

const logDir = process.env.CUE_LOG_DIR || "logs";
const LLM_PORT = Number(process.env.CUE_LLM_PORT || 8081);
const ASR_PORT = Number(process.env.CUE_ASR_PORT || 8082);
// Vision tokens per screenshot. Measured on an M3 Pro (scripts/eval-context.mjs, the overlay's
// 1280 px JPEG): 512 alone 16/20 (digits misread), 256 + screen text 20/20 at 3.2 s. With the
// screen's text in the turn the image only has to carry the layout.
export const imageTokens = Number(process.env.CUE_IMAGE_TOKENS || (hasScreenText ? 256 : 512));

const servers = {
  llama: { name: "llama-server", port: LLM_PORT, brew: "llama.cpp", child: null, args: null, state: "off", detail: "" },
  whisper: { name: "whisper-server", port: ASR_PORT, brew: "whisper-cpp", child: null, args: null, state: "off", detail: "" },
};

const installed = (binary) => spawnSync("/bin/sh", ["-c", `command -v ${binary}`]).status === 0;
const healthy = (port) => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);

// What each server needs right now, from the current settings: null when Cue should not run it.
function wanted() {
  if (!config.chosen) return { llama: null, whisper: null };
  const llama = config.llmBackend === "local" && !process.env.CUE_LLM_BASE_URL ? resolveModel(config.localModel) : null;
  const whisper = config.asrBackend === "local" && !process.env.CUE_ASR_BASE_URL && !isMock(config.asrBaseUrl) ? whisperModel : null;
  return {
    llama: llama && {
      missing: llama.files.filter((file) => !file.present),
      args: ["-m", llama.files[0].path, ...(llama.files[1] ? ["--mmproj", llama.files[1].path] : []),
        "--port", String(LLM_PORT), "-c", "16384", "-ngl", "99", "--image-max-tokens", String(imageTokens)],
      label: llama.label,
    },
    whisper: whisper && {
      missing: existsSync(whisper.path) && statSync(whisper.path).size > 0 ? [] : [{ path: whisper.path }],
      args: ["-m", whisper.path, "--port", String(ASR_PORT), "--inference-path", "/v1/audio/transcriptions", "-l", "auto", "-t", "8"],
      label: "whisper large-v3-turbo",
    },
  };
}

// Bring both servers in line with the settings. Safe to call any time; concurrent calls queue.
let syncing = Promise.resolve();
export function syncLocalServers() {
  syncing = syncing.then(() => Promise.all([sync("llama"), sync("whisper")])).catch((error) => console.error(`[servers] ${error.message}`));
  return syncing;
}

async function sync(key) {
  const server = servers[key];
  const want = wanted()[key];
  if (!want) {
    const elsewhere = key === "llama" ? config.llmBackend === "local" && process.env.CUE_LLM_BASE_URL : config.asrBackend === "local" && process.env.CUE_ASR_BASE_URL;
    return elsewhere && config.chosen ? stop(server, "external", `Using ${elsewhere}; Cue does not start this server.`) : stop(server, "off");
  }
  if (want.missing.length) return stop(server, "needs-model", `${want.label} is not downloaded yet.`);
  if (server.child && server.args === want.args.join(" ")) return;
  // The old process must be gone before the port is probed, or it would pass for someone else's.
  await stopAndWait(server);
  if (await healthy(server.port)) {
    // Someone else's server (an earlier `npm run app`, a manual llama-server): use it, but say so,
    // since it may run a different model than the one chosen here.
    server.state = "external";
    server.detail = `Using the ${server.name} already running on :${server.port}; Cue did not start it.`;
    return;
  }
  if (!installed(server.name)) {
    server.state = "not-installed";
    server.detail = `${server.name} is not installed. Install it with: brew install ${server.brew}`;
    return;
  }
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `${key}.log`), "w");
  const child = spawn(server.name, want.args, { stdio: ["ignore", log, log] });
  closeSync(log);   // the child has its own copy
  server.child = child;
  server.args = want.args.join(" ");
  server.state = "starting";
  server.detail = `Loading ${want.label}…`;
  child.on("exit", (code, signal) => {
    if (server.child !== child) return;
    server.child = null;
    server.args = null;
    server.state = "exited";
    server.detail = `${server.name} stopped (${signal || `exit ${code}`}); see ${join(logDir, `${key}.log`)}.`;
  });
  child.on("error", (error) => {
    if (server.child !== child) return;
    server.state = "exited";
    server.detail = `${server.name} could not start: ${error.message}`;
  });
  // Loading runs outside the sync queue, so a backend switch or a finished download is not stuck
  // behind a model that takes minutes to load. llama-server answers 503 until /health says ok.
  (async () => {
    const deadline = Date.now() + 10 * 60_000;
    while (server.child === child && Date.now() < deadline) {
      if (await healthy(server.port)) {
        if (server.child === child) { server.state = "up"; server.detail = want.label; }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (server.child === child) {
      stop(server, "exited", `${server.name} did not come up in 10 minutes; see ${join(logDir, `${key}.log`)}.`);
    }
  })();
}

function stop(server, state = "off", detail = "") {
  const child = server.child;
  if (child) {
    server.child = null;
    child.kill("SIGTERM");
  }
  server.args = null;
  server.state = state;
  server.detail = detail;
  return child;
}

async function stopAndWait(server) {
  const child = stop(server);
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}

export function localServerStatus() {
  return Object.fromEntries(Object.entries(servers).map(([key, { state, detail }]) => [key, { state, detail }]));
}

export function stopLocalServers() {
  for (const server of Object.values(servers)) stop(server);
}
// Any exit, not only a signal: a model server left behind holds gigabytes of memory and the port.
process.on("exit", stopLocalServers);
