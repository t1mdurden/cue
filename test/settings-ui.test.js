// The Settings window's Model tab (public/answers.js), driven through the real page in Electron (the
// binary `npm run app` installs) against a mock-provider server: the Transcription choice, the Claude
// model and sign-in. Skipped where there is no Electron binary (Docker, CI without the client install).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const electron = new URL("../client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", import.meta.url).pathname;
const skip = process.platform !== "darwin" || !existsSync(electron) ? "no Electron binary (npm run app installs it)" : false;
const port = 48831;
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "cue-settings-ui-"));

// Loads settings.html in a hidden window, waits until the Model page has rendered from the server,
// runs `script` (an async function body) in the page and prints its result as JSON.
const driver = join(dir, "driver.cjs");
writeFileSync(driver, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  app.dock?.hide();
  process.on("unhandledRejection", (error) => { process.stdout.write(JSON.stringify({ error: String(error) })); app.exit(1); });
  const win = new BrowserWindow({ show: false });
  await win.loadURL(process.argv.at(-2));
  const result = await win.webContents.executeJavaScript(\`(async () => {
    for (let i = 0; i < 100 && !document.querySelector("#answers .detail"); i++) await new Promise((r) => setTimeout(r, 50));
    \${process.argv.at(-1)}
  })()\`);
  process.stdout.write(JSON.stringify(result));
  app.exit(0);
});`);

async function page(script, path = "/settings.html#model") {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [driver, `${base}${path}`, script], { env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await once(child, "exit");
  return JSON.parse(out);
}

async function withServer(extraEnv, body) {
  const env = { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: join(dir, `store-${Date.now()}.json`), ...extraEnv };
  for (const key of ["CUE_LLM_BACKEND", "CUE_ASR_BACKEND", "OPENAI_API_KEY"]) if (!(key in extraEnv)) delete env[key];
  const server = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 50)); }
    if (!up) throw new Error("server did not start");
    await body();
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}

const readSelect = `const s = document.getElementById("asr-backend");
  return { options: [...s.options].map((o) => [o.value, o.textContent]), value: s.value };`;

test("Settings offers OpenAI transcription and says it needs a key while none is set", { skip, timeout: 30_000 }, async () => {
  await withServer({ CUE_LLM_BACKEND: "local" }, async () => {
    assert.deepEqual(await page(readSelect), { options: [["local", "This Mac"], ["openai", "OpenAI"]], value: "local" });
    const desc = await page(`const s = document.getElementById("asr-backend");
      s.value = "openai";
      s.dispatchEvent(new Event("change"));
      for (let i = 0; i < 100 && !/OpenAI, with/.test(document.querySelector("#asr-backend").closest(".row").textContent); i++) await new Promise((r) => setTimeout(r, 50));
      return document.querySelector("#asr-backend").closest(".row").querySelector(".desc").textContent;`);
    assert.equal(desc, "OpenAI, with your OpenAI API key (not set yet: add it under OpenAI API). Your audio goes to OpenAI.");
  });
});

test("choosing OpenAI transcription in Settings reaches the server and survives a reload", { skip, timeout: 30_000 }, async () => {
  await withServer({ CUE_LLM_BACKEND: "local", OPENAI_API_KEY: "sk-test" }, async () => {
    assert.deepEqual(await page(readSelect), { options: [["local", "This Mac"], ["openai", "OpenAI"]], value: "local" });
    await page(`const s = document.getElementById("asr-backend");
      s.value = "openai";
      s.dispatchEvent(new Event("change"));
      for (let i = 0; i < 100; i++) {
        const r = await fetch("/rpc/settings/get", { method: "POST", headers: { authorization: "Bearer dev-token", "content-type": "application/json" }, body: '{"json":{},"meta":[]}' });
        if ((await r.json()).json.asrBackend === "openai") return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;`);
    const saved = await fetch(`${base}/rpc/settings/get`, { method: "POST", headers: { authorization: "Bearer dev-token", "content-type": "application/json" }, body: '{"json":{},"meta":[]}' });
    assert.equal((await saved.json()).json.asrBackend, "openai", "the change event saved the choice");
    assert.equal((await page(readSelect)).value, "openai", "a fresh Settings window shows the saved choice");
  });
});

// A stand-in `claude` on PATH (see test/settings.test.js) so the page shows each sign-in state.
// With loggedIn "after-login" it reports signed out until `auth login` has run, like a real sign-in;
// with "login-fails" its login exits 1 the way CLI 2.1.56 does.
function fakeClaude(loggedIn) {
  const bin = mkdtempSync(join(tmpdir(), "cue-fake-claude-"));
  const yes = JSON.stringify({ loggedIn: true, email: "person@example.com", subscriptionType: "max" });
  const no = JSON.stringify({ loggedIn: false });
  const status = loggedIn === "after-login" ? `if [ -f "${bin}/signed" ]; then echo '${yes}'; else echo '${no}'; fi` : `echo '${loggedIn === true ? yes : no}'`;
  const login = loggedIn === "login-fails" ? `echo "error: unknown option '--claudeai'" >&2; exit 1` : `touch "${bin}/signed"`;
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "  --safe-mode"; exit 0; fi\nif [ "$1 $2" = "auth status" ]; then ${status}; fi\nif [ "$1 $2" = "auth login" ]; then ${login}; fi\nexit 0\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return `${bin}:/usr/bin:/bin`;
}
const readClaude = `for (let i = 0; i < 100 && /Checking/.test(document.getElementById("claude-auth").textContent); i++) await new Promise((r) => setTimeout(r, 50));
  const m = document.getElementById("claude-model"), e = document.getElementById("claude-effort");
  return { models: [...m.options].map((o) => [o.value, o.textContent]), model: m.value, efforts: [...e.options].map((o) => o.value), effort: e.value,
    auth: document.getElementById("claude-auth").textContent, signIn: Boolean(document.getElementById("claude-login")) };`;

test("Settings offers every Claude model by full ID with Fable selected, and a pick reaches the server", { skip, timeout: 30_000 }, async () => {
  await withServer({ CUE_LLM_BACKEND: "claude", PATH: fakeClaude(true) }, async () => {
    const shown = await page(readClaude);
    assert.deepEqual(shown.models, [["claude-fable-5-1", "Fable 5.1"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-4-5", "Haiku 4.5"]]);
    assert.equal(shown.model, "claude-fable-5-1");
    assert.deepEqual(shown.efforts, ["low", "medium", "high"]);
    assert.equal(shown.auth, "Signed in as person@example.com · max plan.");
    assert.equal(shown.signIn, false);
    await page(`const s = document.getElementById("claude-model");
      s.value = "claude-opus-5-5";
      s.dispatchEvent(new Event("change"));
      for (let i = 0; i < 100 && document.getElementById("claude-model-desc").textContent.startsWith("Best"); i++) await new Promise((r) => setTimeout(r, 50));
      return true;`);
    const saved = await fetch(`${base}/rpc/settings/get`, { method: "POST", headers: { authorization: "Bearer dev-token", "content-type": "application/json" }, body: '{"json":{},"meta":[]}' });
    assert.equal((await saved.json()).json.claudeModel, "claude-opus-5-5");
  });
});

test("a signed-out Claude CLI is shown in Settings with a Sign in button, and in the overlay before any question", { skip, timeout: 30_000 }, async () => {
  await withServer({ CUE_LLM_BACKEND: "claude", PATH: fakeClaude(false) }, async () => {
    const shown = await page(readClaude);
    assert.equal(shown.auth, "Not signed in — answers will fail until you sign in.");
    assert.equal(shown.signIn, true);
    const overlay = await page(`for (let i = 0; i < 100 && !/not signed in/.test(document.getElementById("chat-input").placeholder); i++) await new Promise((r) => setTimeout(r, 50));
      return document.getElementById("chat-input").placeholder;`, "/");
    assert.equal(overlay, "Claude is not signed in: answers will fail. Settings → Model → Sign in.");
  });
});

test("Sign in runs the CLI's login and the page shows the account once the login lands, without a restart", { skip, timeout: 30_000 }, async () => {
  await withServer({ CUE_LLM_BACKEND: "claude", PATH: fakeClaude("after-login") }, async () => {
    const after = await page(`for (let i = 0; i < 100 && /Checking/.test(document.getElementById("claude-auth").textContent); i++) await new Promise((r) => setTimeout(r, 50));
      const before = document.getElementById("claude-auth").textContent;
      document.getElementById("claude-login").click();
      for (let i = 0; i < 160 && !/^Signed in/.test(document.getElementById("claude-auth").textContent); i++) await new Promise((r) => setTimeout(r, 50));
      return { before, after: document.getElementById("claude-auth").textContent, button: Boolean(document.getElementById("claude-login")) };`);
    assert.deepEqual(after, { before: "Not signed in — answers will fail until you sign in.", after: "Signed in as person@example.com · max plan.", button: false });
  });
});

test("a sign-in that fails at once says so instead of waiting for the browser", { skip, timeout: 30_000 }, async () => {
  await withServer({ CUE_LLM_BACKEND: "claude", PATH: fakeClaude("login-fails") }, async () => {
    const text = await page(`for (let i = 0; i < 100 && /Checking/.test(document.getElementById("claude-auth").textContent); i++) await new Promise((r) => setTimeout(r, 50));
      document.getElementById("claude-login").click();
      for (let i = 0; i < 160 && !/^Sign-in failed/.test(document.getElementById("claude-auth").textContent); i++) await new Promise((r) => setTimeout(r, 50));
      return document.getElementById("claude-auth").textContent;`);
    assert.equal(text, "Sign-in failed: error: unknown option '--claudeai'");
  });
});
