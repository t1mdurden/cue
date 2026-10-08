// Chat backend that runs on a Claude subscription instead of a local model or an OpenAI key, through
// the Claude Code CLI. It needs no GPU, so it works on any Mac.
//
// Each room keeps one long-lived `claude -p` process speaking stream-json on stdin/stdout, spawned
// when the room's socket opens so its ~3 s start-up is paid before the first question. A turn writes
// one user message (the screenshot inline as an image block) and streams text deltas back as they
// arrive; the conversation lives in that process. Measured with scripts/bench.mjs (sonnet, screen +
// transcript question): 1.6 s p50 to the first token, against 10 s for the previous one-shot
// `claude -p` that spent a second model turn reading the screenshot from a temp file and streamed
// nothing until the answer was complete.
//
// --system-prompt replaces Claude Code's own coding-agent prompt with Cue's (0.8 s off the first
// token); --effort low skips most deliberation; --safe-mode keeps the user's hooks, plugins, MCP
// servers and CLAUDE.md out of the child (a Stop hook can otherwise hold a turn open indefinitely);
// --tools "" gives the model no tools at all; --no-session-persistence keeps transcripts out of ~/.claude.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { config } from "./config.js";

const processes = new Map(); // sessionKey -> ClaudeProcess

class ClaudeProcess {
  constructor(system, model) {
    this.system = system;
    this.model = model;
    this.fresh = true; // no turn has run in this process yet
    this.turn = null;  // { push(event), fail(error) } for the turn in flight
    this.queue = Promise.resolve();
    this.child = spawn("claude", [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--verbose", "--model", model, "--effort", config.claudeEffort,
      "--system-prompt", system, "--tools", "", "--safe-mode", "--no-session-persistence",
    ], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    let pending = "";
    // A child that exits while a screenshot is still being written raises EPIPE on stdin; unhandled,
    // that would take the whole app server down.
    this.child.stdin.on("error", (error) => this.die(error));
    this.child.stdout.setEncoding("utf8"); // a multi-byte character can straddle two reads
    this.child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        this.turn?.push(event);
      }
    });
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.child.on("error", (error) => this.die(error));
    this.child.on("close", (code) => this.die(new Error(`claude exited ${code}${this.stderr ? `: ${this.stderr.slice(0, 300)}` : ""}`)));
  }

  die(error) {
    this.dead = true;
    this.turn?.fail(error);
    this.turn = null;
  }

  // Turns run one at a time: a second ask waits until the first has streamed its result.
  async *ask(content, signal) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      if (signal?.aborted) return; // cancelled while the turn before it was still running
      yield* this.#turn(content, signal);
    } finally {
      release();
    }
  }

  async *#turn(content, signal) {
    if (this.dead) throw new Error("claude process is not running");
    this.fresh = false;
    const events = [];
    let wake = null, failure = null, done = false;
    this.turn = {
      push: (event) => { events.push(event); wake?.(); },
      fail: (error) => { failure = error; wake?.(); },
    };
    // The CLI's own interrupt ends the turn in milliseconds with a result and keeps the process
    // and its conversation; without it a cancelled question runs to the end of an answer nobody
    // reads, and the next question waits behind it. One that reaches the CLI together with the
    // question is ignored, so finally sends it again; a repeat to an idle CLI does nothing.
    const interrupt = () => {
      if (this.dead) return;
      this.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`);
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    this.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
    try {
      while (!done) {
        if (!events.length && !failure) await new Promise((resolve) => (wake = resolve));
        wake = null;
        if (failure) throw failure;
        while (events.length) {
          const event = events.shift();
          if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
            yield event.event.delta.text;
          } else if (event.type === "result") {
            done = true;
            if (event.is_error) throw new Error(`claude error: ${String(event.result || event.subtype).slice(0, 300)}`);
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", interrupt);
      // Abandoned mid-answer (the question was cancelled): stop it, and swallow what is still in
      // flight up to its result before the next turn may write.
      if (!done && !failure && !this.dead) {
        interrupt();
        await new Promise((resolve) => {
          this.turn = { push: (event) => event.type === "result" && resolve(), fail: resolve };
          for (const event of events) if (event.type === "result") resolve();
        });
      }
      this.turn = null;
    }
  }

  kill() {
    this.dead = true;
    this.child.kill("SIGTERM");
  }
}

function processFor(key, system) {
  let proc = processes.get(key);
  if (proc && (proc.dead || proc.system !== system || proc.model !== config.claudeModel)) {
    proc.kill();
    proc = null;
  }
  if (!proc) {
    proc = new ClaudeProcess(system, config.claudeModel);
    processes.set(key, proc);
  }
  return proc;
}

// Spawn a room's process ahead of its first question.
export function warmClaudeSession(sessionKey, system) {
  processFor(sessionKey || "default", system);
}

// messages: [{ role, text, images?: [dataUrl] }] — only the newest message is sent; the process
// already holds the conversation. A process that is new to a room with history (server restart,
// mode change) gets the earlier turns as text so the answer keeps its context.
export async function* claudeStreamChat({ system, messages, sessionKey, signal }) {
  const proc = processFor(sessionKey || "default", system);
  const last = messages.at(-1) || { text: "" };
  const earlier = proc.fresh ? messages.slice(0, -1) : [];
  const preface = earlier.length
    ? `Earlier in this conversation:\n${earlier.map((m) => `${m.role === "assistant" ? "You" : "User"}: ${m.text}`).join("\n\n")}\n\n---\n\n`
    : "";
  const content = [
    ...(last.images || []).map((url) => {
      const [, mediaType, data] = url.match(/^data:([^;]+);base64,(.*)$/s) || [];
      return { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: data || "" } };
    }),
    { type: "text", text: preface + (last.text || "") },
  ];
  yield* proc.ask(content, signal);
}

export function resetClaudeSession(sessionKey) {
  processes.get(sessionKey || "default")?.kill();
  processes.delete(sessionKey || "default");
}

export function stopAllClaudeSessions() {
  for (const proc of processes.values()) proc.kill();
  processes.clear();
}

// Runs the CLI once: { code, stdout, stderr } | { missing } | { failed } | { timedOut }.
function runClaude(args) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const child = spawn("claude", args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timedOut: true }); }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve(error.code === "ENOENT" ? { missing: true } : { failed: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// The `claude` that a spawn will run: the first one on PATH, named in the outdated warning.
function claudeOnPath() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const file = join(dir, "claude");
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

// Whether the CLI can answer at all, asked before the first question instead of discovered by it:
// { state: "signed-in", email, plan } | "signed-out" | "missing" | "outdated" | "error", with a
// detail where there is one. ~0.3 s; a 10 s cache keeps the About tab's 3 s poll from spawning it
// every time. The CLI keeps the login itself (Keychain), so signing in once survives restarts.
let authCache = null;
export function claudeAuthStatus({ fresh = false } = {}) {
  if (!fresh && authCache && Date.now() - authCache.at < 10_000) return authCache.status;
  const status = checkClaude();
  authCache = { at: Date.now(), status };
  return status;
}

async function checkClaude() {
  // An old npm install earlier on PATH shadows the native one (seen: /opt/homebrew/bin/claude
  // 2.1.56 ahead of ~/.local/bin/claude 2.1.292). It reports the login fine but rejects --safe-mode,
  // so every answer would fail behind a "signed in" status: check the flag Cue's spawn depends on.
  const help = await runClaude(["--help"]);
  if (help.missing) return { state: "missing" };
  if (help.timedOut || help.failed) return { state: "error", detail: help.failed || "claude --help did not answer in 10 s" };
  if (!help.stdout.includes("--safe-mode")) {
    const version = (await runClaude(["--version"])).stdout?.trim().split("\n")[0] || "unknown version";
    return { state: "outdated", detail: `${version} at ${claudeOnPath() || "claude"}` };
  }
  const auth = await runClaude(["auth", "status"]);
  if (auth.timedOut || auth.failed || auth.missing) return { state: "error", detail: auth.failed || "claude auth status did not answer in 10 s" };
  try {
    const parsed = JSON.parse(auth.stdout);
    return parsed.loggedIn ? { state: "signed-in", email: parsed.email || null, plan: parsed.subscriptionType || null } : { state: "signed-out" };
  } catch {
    return { state: "error", detail: (auth.stderr || auth.stdout).trim().slice(0, 200) || "claude auth status printed nothing" };
  }
}

// Starts the CLI's own sign-in: it opens the browser and finishes on its localhost callback, with
// no terminal needed. Cue holds no credential; the next status check sees the stored login. A login
// that exits non-zero (an old CLI without --claudeai, access denied in the browser) leaves its last
// line in claudeLoginError() for Settings to show instead of waiting.
let login = null;
let loginError = null;
export function startClaudeLogin() {
  if (login && login.exitCode === null && login.signalCode === null) return;
  loginError = null;
  let output = "";
  const child = spawn("claude", ["auth", "login", "--claudeai"], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
  login = child;
  const keep = (chunk) => { output = (output + chunk).slice(-1000); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (error) => { loginError = error.code === "ENOENT" ? "the claude CLI is not installed" : error.message; });
  child.on("close", (code) => {
    authCache = null;
    if (code && !loginError) loginError = output.trim().split("\n").at(-1)?.slice(0, 200) || `claude auth login exited ${code}`;
  });
  // A sign-in left open in the browser is abandoned after 10 minutes rather than kept forever.
  setTimeout(() => child.kill("SIGTERM"), 600_000).unref();
  authCache = null;
}

export function claudeLoginError() {
  return loginError;
}

// The sign-in waits on a localhost port; it must not outlive Cue.
export function stopClaudeLogin() {
  if (login && login.exitCode === null && login.signalCode === null) login.kill("SIGTERM");
}
