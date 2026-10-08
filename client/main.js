const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, shell, systemPreferences } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

// The overlay is a transparent, frameless, always-on-top panel that hides from screen capture.
// Mic ("me") is captured in the renderer via getUserMedia; macOS system audio ("them") comes from
// Cue's own helper (native/system-audio.swift) and is forwarded over chat-audio-data.
const serverUrl = process.env.CUE_SERVER_URL || "http://localhost:8787";
const origin = new URL(serverUrl).origin;
// The helpers are built into the server's bin/: next to the overlay inside Cue.app, the repo root
// under `npm run app` (scripts/start-local.sh builds them).
const serverDir = app.isPackaged ? path.join(__dirname, "server") : path.join(__dirname, "..");
const systemAudioHelper = process.env.CUE_SYSTEM_AUDIO || path.join(serverDir, "bin", "system-audio");
const MOVE_STEP = 60;
// Installed as Cue.app nothing else brings the backend up, so the app runs the same launcher
// `npm run app` uses, in --services-only mode, from the server copy bundled next to this file.
// Under `npm run app` the launcher already did that and passed CUE_SERVER_URL.
const bundledServer = app.isPackaged && !process.env.CUE_SERVER_URL ? path.join(__dirname, "server") : null;
const logDir = path.join(os.homedir(), "Library", "Logs", "Cue");
let services = null;
// `npm run app` keeps its own profile: sharing Cue.app's would share its single-instance lock, and the
// dev overlay would quit silently whenever the installed app is running.
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Cue Dev"));
// One overlay per profile: a second launch would start a second backend on the same ports.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  console.error("[overlay] Cue is already running; this launch hands over to it and exits.");
  app.quit();
}

let overlay;
let systemAudio;
let visible = true;

// Test hook: feed the mic from a WAV file instead of a device (Chromium's fake capture). Auto-
// grants the mic prompt and disables the renderer sandbox so the fake device can read the file —
// test-only, gated behind the env var, never on in a normal run.
if (process.env.CUE_FAKE_MIC_WAV) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${process.env.CUE_FAKE_MIC_WAV}%noloop`);
  app.commandLine.appendSwitch("no-sandbox");
}
// Test hooks: answer screenshot requests with a fixture PNG instead of the real display, and expose
// the renderer over the Chrome DevTools protocol so a script can drive and screenshot the overlay.
const fakeScreen = process.env.CUE_FAKE_SCREEN_PNG ? require("node:fs").readFileSync(process.env.CUE_FAKE_SCREEN_PNG) : null;
if (process.env.CUE_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.CUE_DEBUG_PORT);

const OVERLAY_WIDTH = 690;
let settingsWindow = null;
let setupWindow = null;
let shortcuts = {};
let shortcutFailures = [];
let contentProtection = true;

function createOverlay() {
  const area = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: 104,
    x: Math.round(area.x + (area.width - OVERLAY_WIDTH) / 2),
    y: area.y + 48,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer loads only the app server's pages over loopback; a sandboxed renderer keeps
      // a compromised page away from Node even before the preload's channel allowlist.
      sandbox: true,
      // The overlay is shown without focus, so Chromium treats it as a background page and throttles
      // its timers and IPC; the first Ask after an idle spell then paid ~0.1-0.5 s before any work.
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");       // above full-screen windows
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });
  overlay.loadURL(serverUrl);
  overlay.once("ready-to-show", () => {
    overlay.setContentProtection(contentProtection);  // absent from screenshots and shares
    overlay.showInactive();
    const b = overlay.getBounds();
    console.log(`[overlay] shown bounds=${b.width}x${b.height} at (${b.x},${b.y}) contentProtection=${contentProtection ? "on" : "off"}`);
  });
}

function openSettings(tab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (tab) settingsWindow.webContents.send("settings-tab", tab);
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 920,
    height: 670,
    minWidth: 760,
    minHeight: 520,
    title: "Cue Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#0b0c0d",
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWindow.loadURL(`${serverUrl}/settings.html${tab ? `#${tab}` : ""}`);
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.setContentProtection(contentProtection);
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

// Setup: what to run on, the model it needs, and the macOS permissions. Shown on the first launch and
// whenever a permission is missing, before the overlay exists. Resolves when the window closes.
let setupClosed = null;
function openSetup(step) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    if (step) setupWindow.webContents.send("settings-tab", step);
    setupWindow.show();
    setupWindow.focus();
    return setupClosed;
  }
  setupWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 640,
    minHeight: 520,
    title: "Set up Cue",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#0b0c0d",
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  setupWindow.loadURL(`${serverUrl}/setup.html${step ? `#${step}` : ""}`);
  setupWindow.once("ready-to-show", () => {
    setupWindow.show();
    app.focus({ steal: true });   // no Dock icon: without this the window opens behind the frontmost app
    setupWindow.focus();
  });
  setupClosed = new Promise((resolve) => setupWindow.on("closed", () => { setupWindow = null; resolve(); }));
  return setupClosed;
}

// ---- permissions ---------------------------------------------------------------------------
// A session needs three macOS grants; without one it records silence or a black screen and says
// nothing about it. Setup and Settings show them, and the overlay starts no session while one is
// missing. Under `npm run app` macOS asks on behalf of the app that started the terminal, not Cue.
// The fake-capture test hook stands in for the devices, so it needs no grants.
const fakeCapture = Boolean(process.env.CUE_FAKE_MIC_WAV);
const settingsPane = { microphone: "Privacy_Microphone", screen: "Privacy_ScreenCapture", systemAudio: "Privacy_AudioCapture" };
let screenAsked = false;

function systemAudioPermission(command) {
  return new Promise((resolve) => {
    execFile(systemAudioHelper, [command], { timeout: command === "request" ? 300000 : 5000 }, (error, stdout) => {
      resolve(error ? "unavailable" : stdout.trim());
    });
  });
}

async function permissions() {
  if (process.platform !== "darwin" || fakeCapture) return { microphone: "granted", screen: "granted", systemAudio: "granted", screenAsked: false };
  // macOS reports Screen Recording as "denied" for an app that has never asked, and does not list
  // it in System Settings until it has. So before Cue asks, a missing grant reads as not asked yet.
  const screen = systemPreferences.getMediaAccessStatus("screen") === "granted" ? "granted" : screenAsked ? "denied" : "not-determined";
  return {
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    screen,
    systemAudio: await systemAudioPermission("status"),
    // macOS applies a Screen Recording grant only to a relaunched app: once asked, offer Relaunch.
    screenAsked,
  };
}

// The grants a session cannot do without. A missing helper ("unavailable": built without the Xcode
// command line tools) leaves the session without "them", which Setup explains, but does not block it.
async function missingPermissions() {
  const status = await permissions();
  return ["microphone", "screen", "systemAudio"].filter((kind) => status[kind] !== "granted" && status[kind] !== "unavailable");
}

// Ask macOS while it still can ask (not determined); once denied only System Settings can change it.
async function requestPermission(kind) {
  const status = (await permissions())[kind];
  if (status === "granted") return;
  if (kind === "microphone" && status === "not-determined") return void (await systemPreferences.askForMediaAccess("microphone"));
  if (kind === "systemAudio" && status === "not-determined") return void (await systemAudioPermission("request"));
  if (kind === "screen") {
    screenAsked = true;
    // Listing screens is what makes macOS put Cue in the Screen Recording list (and prompt, the first
    // time); then the pane where the person switches it on.
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
  }
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${settingsPane[kind]}`);
}

// Settings live in the app server's store; read them once the server answers, then apply.
async function loadSettings() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/rpc/settings/get`, {
        method: "POST",
        headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ json: {}, meta: [] }),
      });
      if (response.ok) return (await response.json()).json;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function applySettings(settings) {
  if (!settings) return [];
  if (typeof settings.contentProtection === "boolean") {
    contentProtection = settings.contentProtection;
    for (const win of [overlay, settingsWindow]) if (win && !win.isDestroyed()) win.setContentProtection(contentProtection);
  }
  return settings.shortcuts ? registerShortcuts(settings.shortcuts) : [];
}

// Launched from Finder there is no terminal: main-process logs go next to the services' logs.
if (bundledServer && primaryInstance) {
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.createWriteStream(path.join(logDir, "overlay.log"), { flags: "w" });
  console.log = (...args) => out.write(`${util.format(...args)}\n`);
  console.error = console.log;
}

const healthy = () => fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);

// Start the launcher and wait for the app server — no deadline, a first run downloads the model.
// Returns an error message instead when it cannot come up.
async function startServices() {
  // A relaunch (after a Screen Recording grant) starts while the old instance's services wind down.
  for (let waited = 0; (await healthy()) && waited < 10; waited++) await new Promise((resolve) => setTimeout(resolve, 500));
  if (await healthy()) return `Port ${new URL(serverUrl).port} is already in use (is \`npm run app\` running?). Quit it and open Cue again.`;
  const log = path.join(logDir, "launcher.log");
  const fd = fs.openSync(log, "w");
  // Finder starts apps with PATH=/usr/bin:/bin:/usr/sbin:/sbin; llama.cpp and whisper.cpp
  // (Homebrew) and the claude CLI live outside it. ~/.local/bin goes first: the native claude
  // installer keeps itself current there, while an old npm install in /opt/homebrew/bin (2.1.56,
  // seen on this Mac) rejects the flags Cue passes.
  const extraPath = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  services = spawn("/bin/bash", [path.join(bundledServer, "scripts", "start-local.sh"), "--services-only"], {
    cwd: bundledServer,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      PATH: [...extraPath, process.env.PATH].join(":"),
      CUE_NODE: process.execPath,
      CUE_LOG_DIR: logDir,
      // Absolute, so nothing resolves inside the signed bundle (the launcher's cwd); "" keeps meaning off.
      CUE_DATA_FILE: process.env.CUE_DATA_FILE === "" ? "" : path.resolve(process.env.CUE_DATA_FILE || path.join(app.getPath("appData"), "Cue", "store.json")),
    },
  });
  let exited = false;
  services.once("exit", () => { exited = true; });
  while (!exited) {
    if (await healthy()) return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return fs.readFileSync(log, "utf8").trim().split("\n").slice(-6).join("\n") || "The launcher exited without output.";
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  if (app.dock) app.dock.hide();                       // not in the Dock or Cmd+Tab
  if (bundledServer) {
    const failure = await startServices();
    if (failure) {
      dialog.showErrorBox("Cue could not start", `${failure}\n\nLogs: ${logDir}`);
      return app.quit();
    }
  }
  const settings = await loadSettings();
  if (settings) contentProtection = settings.contentProtection;
  if (!settings?.setupDone || (await missingPermissions()).length) await openSetup();
  if (!overlay) createOverlay();
  applySettings(settings);
});

app.on("second-instance", () => { if (overlay) { visible = true; overlay.showInactive(); } });
// Closing Setup before the overlay exists must not end the app: the overlay opens next.
app.on("window-all-closed", () => { if (overlay) app.quit(); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); stopSystemAudio(); services?.kill("SIGTERM"); });
app.on("before-quit", stopSystemAudio);

// ---- global hotkeys (defaults in src/rpc.js, changeable in Settings) ---------------------------
const actions = {
  toggleVisibility: () => toggleVisibility(),
  ask: () => send("hotkey", "ask"),
  clear: () => send("hotkey", "clear"),
  openSettings: () => openSettings(),
  toggleSession: () => send("hotkey", "toggleSession"),
  moveUp: () => moveOverlay(0, -MOVE_STEP),
  moveDown: () => moveOverlay(0, MOVE_STEP),
  moveLeft: () => moveOverlay(-MOVE_STEP, 0),
  moveRight: () => moveOverlay(MOVE_STEP, 0),
};

// Returns the actions whose accelerator could not be registered (taken by another app, or invalid).
function registerShortcuts(map) {
  // Settings get re-applied more than once during boot (initial load, then settings-changed). The
  // accelerators are the same each time, so skip the unregister/register churn — and the log noise,
  // and the brief gap where a hotkey is momentarily unbound — when nothing actually changed.
  if (JSON.stringify(map) === JSON.stringify(shortcuts)) return shortcutFailures;
  globalShortcut.unregisterAll();
  shortcuts = map;
  const failed = Object.entries(map).filter(([action, accelerator]) => {
    if (!Object.hasOwn(actions, action)) return false;
    try { return !globalShortcut.register(accelerator, actions[action]); } catch { return true; }
  }).map(([action]) => action);
  shortcutFailures = failed;
  console.log(`[overlay] hotkeys registered=${Object.keys(map).length - failed.length}${failed.length ? ` taken=${failed.join(",")}` : ""}`);
  return failed;
}

function toggleVisibility() {
  if (!overlay) return;
  visible = !visible;
  visible ? overlay.showInactive() : overlay.hide();
}

function moveOverlay(dx, dy) {
  if (!overlay) return;
  const [x, y] = overlay.getPosition();
  const { width, height } = overlay.getBounds();
  const area = screen.getDisplayMatching(overlay.getBounds()).workArea;
  const clampedX = Math.min(Math.max(x + dx, area.x), area.x + area.width - width);
  const clampedY = Math.min(Math.max(y + dy, area.y), area.y + area.height - height);
  overlay.setPosition(Math.round(clampedX), Math.round(clampedY));
}

function send(channel, value) {
  overlay?.webContents.send(channel, value);
}

// The overlay sizes itself to its state (104 px bar, 500 px chat, 760 px history), keeping its top
// edge where it is.
ipcMain.handle("overlay-resize", (event, { height }) => {
  assertTrusted(event);
  if (!overlay) return;
  const bounds = overlay.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const h = Math.max(60, Math.min(Math.round(height), area.height));
  const y = Math.min(bounds.y, area.y + area.height - h);
  overlay.setBounds({ x: bounds.x, y, width: OVERLAY_WIDTH, height: h });
});

ipcMain.on("open-settings", (event, tab) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  openSettings(tab);
});

ipcMain.on("open-setup", (event, step) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  openSetup(step);
});

ipcMain.on("setup-done", (event) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  setupWindow?.close();
});

ipcMain.handle("permissions", (event) => {
  assertTrusted(event);
  return permissions();
});

ipcMain.handle("permission-request", async (event, kind) => {
  assertTrusted(event);
  if (!Object.hasOwn(settingsPane, kind)) throw new Error(`Unknown permission: ${kind}`);
  await requestPermission(kind);
  return permissions();
});

ipcMain.on("relaunch", (event) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  app.relaunch();
  app.quit();
});

ipcMain.on("quit-app", (event) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  app.quit();
});

// A window changed settings on the server: apply what lives in this process, tell every window.
ipcMain.handle("settings-changed", (event, settings) => {
  assertTrusted(event);
  const failed = applySettings(settings);
  for (const win of [overlay, settingsWindow]) if (win && !win.isDestroyed() && win.webContents !== event.sender) win.webContents.send("settings-changed", settings);
  return { failed };
});

// ---- screenshot --------------------------------------------------------------
// maxSide comes from the server's /config: no larger than the model will look at (a local VLM
// downsizes to its vision-token budget anyway, Claude to ~1568 px), so capture and encoding stay cheap.
ipcMain.handle("capture-screenshot", async (event, { maxSide = 1920 } = {}) => {
  assertTrusted(event);
  if (fakeScreen) return { data: new Uint8Array(fakeScreen), contentType: "image/png" };
  const bounds = overlay?.getBounds();
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const scale = Math.min(1, maxSide / Math.max(display.bounds.width, display.bounds.height));
  // Hide the overlay from its own screenshot (content protection already blocks captures, but
  // this also keeps it out of the thumbnail the model sees).
  for (let attempt = 0; attempt < 3; attempt++) {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (source && !source.thumbnail.isEmpty()) {
      return { data: new Uint8Array(source.thumbnail.toJPEG(85)), contentType: "image/jpeg" };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("No screen source found");
});

// ---- system audio ("them") -----------------------------------------------------------------
ipcMain.on("session-start", (event) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  stopSystemAudio();
  if (fakeCapture) return;   // the test hook feeds the mic from a file; it must not tap the real speakers
  const child = spawn(systemAudioHelper, ["--sample-rate", "48000", "--chunk-duration", "0.05"]);
  systemAudio = child;
  let errors = "";
  child.stdout.on("data", (chunk) => send("chat-audio-data", { role: "them", chunk: new Uint8Array(chunk) }));
  child.stderr.on("data", (data) => { errors = (errors + data).slice(-500); });
  child.on("error", (error) => send("hotkey-error", `System audio: ${error.message}`));
  child.on("exit", (code) => {
    if (code) send("hotkey-error", `System audio stopped: ${errors.trim().split("\n").pop() || `exit ${code}`}`);
  });
});

ipcMain.on("session-end", (event) => {
  try { assertTrusted(event); } catch (error) { return console.error(error); }
  stopSystemAudio();
});

function stopSystemAudio() {
  if (systemAudio && !systemAudio.killed) {
    systemAudio.removeAllListeners("exit");   // stopped on purpose: no error to show
    systemAudio.kill("SIGTERM");
  }
  systemAudio = null;
}

// Only the overlay's own origin may drive these channels.
function assertTrusted(event) {
  let senderOrigin = "";
  try { senderOrigin = new URL(event.senderFrame?.url || "").origin; } catch {}
  if (senderOrigin !== origin) throw new Error(`Rejected IPC from ${senderOrigin || "unknown origin"}`);
}
