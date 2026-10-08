import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const port = 48811;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer settings-token", "content-type": "application/json" };

function boot(dataFile) {
  const env = { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: dataFile };
  delete env.CUE_LLM_BACKEND;
  return spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
}
async function call(procedure, input = {}) {
  const r = await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) });
  return { status: r.status, body: (await r.json()).json };
}
async function waitForHealth() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("server did not start");
}
async function stop(server) {
  server.kill("SIGTERM");
  await once(server, "exit");
}

test("settings: defaults, validation, live backend switch, and survival across a restart", async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json");
  let server = boot(dataFile);
  try {
    await waitForHealth();
    const initial = (await call("settings/get")).body;
    assert.equal(initial.contentProtection, true, "hidden from screen sharing by default");
    assert.equal(initial.llmBackend, "local");
    assert.equal(initial.shortcuts.ask, "CommandOrControl+Enter");
    assert.equal((await (await fetch(`${base}/config`)).json()).screenshotMaxSide, 1280, "local model gets a small capture");

    const bad = await call("settings/update", { llmBackend: "gpt-9", shortcuts: { launchRockets: "CommandOrControl+L" } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.data?.fieldErrors?.llmBackend || JSON.stringify(bad.body).includes("llmBackend"), JSON.stringify(bad.body));

    const updated = (await call("settings/update", { llmBackend: "claude", claudeModel: "haiku", contentProtection: false, shortcuts: { clear: "CommandOrControl+Shift+9" } })).body;
    assert.equal(updated.llmBackend, "claude");
    assert.equal(updated.shortcuts.clear, "CommandOrControl+Shift+9");
    assert.equal(updated.shortcuts.ask, "CommandOrControl+Enter", "untouched shortcuts keep their defaults");
    assert.equal((await (await fetch(`${base}/config`)).json()).screenshotMaxSide, 1568, "the running server follows the new backend");
  } finally {
    await stop(server);
  }

  server = boot(dataFile);
  try {
    await waitForHealth();
    // A web page on another origin gets nothing; Cue's own page (and no-Origin local processes) do.
    const foreign = await fetch(`${base}/rpc/settings/update`, { method: "POST", headers: { ...auth, origin: "https://evil.example" }, body: JSON.stringify({ json: { contentProtection: true }, meta: [] }) });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const own = await fetch(`${base}/rpc/settings/get`, { method: "POST", headers: { ...auth, origin: `http://localhost:${port}` }, body: JSON.stringify({ json: {}, meta: [] }) });
    assert.equal(own.status, 200);
    const { default: WebSocket } = await import("ws");
    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/x`, { origin: "https://evil.example" });
      ws.on("open", () => resolve(false));
      ws.on("error", () => resolve(true));
    });
    assert.equal(rejected, true, "cross-origin agent socket refused");

    const after = (await call("settings/get")).body;
    assert.equal(after.llmBackend, "claude");
    assert.equal(after.claudeModel, "claude-haiku-4-5", "an alias is saved as the full ID it means today");
    assert.equal(after.contentProtection, false);
    assert.equal(after.shortcuts.clear, "CommandOrControl+Shift+9");
  } finally {
    await stop(server);
  }
});

test("Claude models: full IDs offered best first, Fable by default, unknown IDs refused, choice survives a restart", async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json");
  let server = boot(dataFile);
  try {
    await waitForHealth();
    const initial = (await call("settings/get")).body;
    assert.deepEqual(initial.claudeModels.map((m) => m.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]);
    assert.deepEqual(initial.claudeEfforts, ["low", "medium", "high"]);
    assert.equal(initial.claudeModel, "claude-fable-5-1");
    assert.equal(initial.claudeEffort, "low");

    const bad = await call("settings/update", { claudeModel: "gpt-9", claudeEffort: "high" });
    assert.equal(bad.status, 422);
    assert.match(JSON.stringify(bad.body), /claude-fable-5-1/, "the error names the allowed IDs");
    assert.equal((await call("settings/get")).body.claudeEffort, "low", "a refused patch applies nothing");

    const chosen = (await call("settings/update", { llmBackend: "claude", claudeModel: "claude-opus-5-5", claudeEffort: "medium" })).body;
    assert.equal(chosen.claudeModel, "claude-opus-5-5");
  } finally {
    await stop(server);
  }
  server = boot(dataFile);
  try {
    await waitForHealth();
    const after = (await call("settings/get")).body;
    assert.equal(after.claudeModel, "claude-opus-5-5");
    assert.equal(after.claudeEffort, "medium");
  } finally {
    await stop(server);
  }
});

test("a store saved with an old alias loads as the current model, not whatever the CLI's alias means", async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json");
  writeFileSync(dataFile, JSON.stringify({ settings: { llmBackend: "claude", claudeModel: "haiku", claudeEffort: "low" }, users: [], rooms: [] }));
  const server = boot(dataFile);
  try {
    await waitForHealth();
    assert.equal((await call("settings/get")).body.claudeModel, "claude-haiku-4-5");
  } finally {
    await stop(server);
  }
});

// A stand-in `claude` on PATH answers `auth status` the way the real CLI does for each state and
// records `auth login`, so the sign-in checks run without touching the real login.
// login: "ok" records the call; "fails" exits 1 the way CLI 2.1.56 does; "waits" sits on the
// browser callback like a sign-in nobody finished, leaving its pid behind.
function fakeClaude(state, login = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "cue-fake-claude-"));
  const status = state === "signed-in"
    ? { loggedIn: true, authMethod: "claude.ai", email: "person@example.com", subscriptionType: "max" }
    : { loggedIn: false, authMethod: "none" };
  const loginBody = {
    ok: `echo "$@" > "${dir}/login-called"; exit 0`,
    fails: `echo "error: unknown option '--claudeai'" >&2; exit 1`,
    waits: `echo $$ > "${dir}/login-pid"; exec sleep 60`,
  }[login];
  writeFileSync(join(dir, "claude"), `#!/bin/sh
if [ "$1" = "--help" ]; then ${state === "outdated" ? 'echo "  -p, --print"' : 'echo "  --safe-mode   no hooks, plugins or MCP"'}; exit 0; fi
if [ "$1" = "--version" ]; then echo "2.1.56 (Claude Code)"; exit 0; fi
if [ "$1 $2" = "auth status" ]; then echo '${JSON.stringify(status)}'; exit 0; fi
if [ "$1 $2" = "auth login" ]; then ${loginBody}; fi
exit 1
`);
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}
function bootClaude(dataFile, path) {
  const env = { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: dataFile, CUE_LLM_BACKEND: "claude", PATH: path };
  return spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
}

test("sign-in is reported before any question: signed in, signed out, CLI missing; Sign in starts the CLI's login", async () => {
  const dataFile = () => join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json");
  for (const [state, chat] of [["signed-in", "signed in"], ["signed-out", "not signed in"]]) {
    const bin = fakeClaude(state);
    const server = bootClaude(dataFile(), `${bin}:/usr/bin:/bin`);
    try {
      await waitForHealth();
      const status = (await call("settings/status", { fresh: true })).body;
      assert.equal(status.claude.state, state);
      assert.equal(status.chat, chat);
      if (state === "signed-in") assert.deepEqual([status.claude.email, status.claude.plan], ["person@example.com", "max"]);
      if (state === "signed-out") {
        assert.deepEqual((await call("settings/claudeLogin")).body, { started: true });
        for (let i = 0; i < 40 && !existsSync(join(bin, "login-called")); i++) await new Promise((r) => setTimeout(r, 50));
        assert.equal(readFileSync(join(bin, "login-called"), "utf8").trim(), "auth login --claudeai");
      }
    } finally {
      await stop(server);
    }
  }
  const server = bootClaude(dataFile(), "/usr/bin:/bin");
  try {
    await waitForHealth();
    const status = (await call("settings/status", { fresh: true })).body;
    assert.equal(status.claude.state, "missing");
    assert.equal(status.chat, "claude CLI not installed");
  } finally {
    await stop(server);
  }
});

test("an old claude first on PATH is reported as too old, not as signed in", async () => {
  const bin = fakeClaude("outdated");
  const server = bootClaude(join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json"), `${bin}:/usr/bin:/bin`);
  try {
    await waitForHealth();
    const status = (await call("settings/status", { fresh: true })).body;
    assert.equal(status.claude.state, "outdated");
    assert.equal(status.claude.detail, `2.1.56 (Claude Code) at ${join(bin, "claude")}`);
    assert.match(status.chat, /^claude CLI too old/);
  } finally {
    await stop(server);
  }
});

test("a sign-in that exits with an error is reported, and one left waiting dies with Cue", async () => {
  const failing = fakeClaude("signed-out", "fails");
  let server = bootClaude(join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json"), `${failing}:/usr/bin:/bin`);
  try {
    await waitForHealth();
    await call("settings/claudeLogin");
    let status;
    for (let i = 0; i < 40 && !status?.claude.loginError; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await call("settings/status", { fresh: true })).body;
    }
    assert.equal(status.claude.loginError, "error: unknown option '--claudeai'");
  } finally {
    await stop(server);
  }

  const waiting = fakeClaude("signed-out", "waits");
  server = bootClaude(join(mkdtempSync(join(tmpdir(), "cue-settings-")), "store.json"), `${waiting}:/usr/bin:/bin`);
  let pid;
  try {
    await waitForHealth();
    await call("settings/claudeLogin");
    for (let i = 0; i < 40 && !existsSync(join(waiting, "login-pid")); i++) await new Promise((r) => setTimeout(r, 50));
    pid = Number(readFileSync(join(waiting, "login-pid"), "utf8"));
    assert.doesNotThrow(() => process.kill(pid, 0), "the sign-in is running");
  } finally {
    await stop(server);
  }
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, "quitting Cue ends the pending sign-in");
});
