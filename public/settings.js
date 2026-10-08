import { mountAnswers } from "/answers.js";
import { mountPermissions } from "/permissions.js";

const native = window.ipcRenderer || null;
const $ = (id) => document.getElementById(id);
const token = localStorage.getItem("cue.token") || "dev-token";
let settings = null;

async function rpc(procedure, input = {}) {
  const response = await fetch(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: input, meta: [] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.json?.message || response.statusText);
  return body.json;
}

// Save to the server, then let the main process apply what it owns (content protection,
// shortcuts) and tell the overlay. Returns the shortcut actions that could not be registered.
async function saveSettings(patch) {
  settings = await rpc("settings/update", patch);
  const result = await native?.invoke("settings-changed", settings).catch(() => null);
  return result?.failed || [];
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}
const icon = (name) => `<svg><use href="/icons.svg#i-${name}"/></svg>`;
const escapeText = (text) => { const d = document.createElement("div"); d.textContent = text ?? ""; return d.innerHTML; };

// ---- tabs ------------------------------------------------------------------------------------

const tabs = [...document.querySelectorAll("#tabs button")];
function showTab(name) {
  if (!tabs.some((t) => t.dataset.tab === name)) name = "general";
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const page of document.querySelectorAll(".page")) page.classList.toggle("active", page.dataset.page === name);
  history.replaceState(null, "", `#${name}`);
  if (name === "about") pollStatus();
  if (name === "audio") listMics();
  if (name === "modes") renderModeList();
  if (name === "model") mountModelTab();
}
tabs.forEach((tab) => (tab.onclick = () => showTab(tab.dataset.tab)));
native?.on("settings-tab", (name) => showTab(name));
native?.on("settings-changed", (next) => { settings = next; renderGeneral(); renderKeybinds(); });

// ---- general ---------------------------------------------------------------------------------

function renderGeneral() {
  const on = settings.contentProtection;
  $("protection").setAttribute("aria-checked", String(on));
  $("protection-desc").textContent = on
    ? "On: Cue does not appear in your screenshots or screen shares."
    : "Off: Cue shows up in screenshots and screen shares like any window.";
}
$("protection").onclick = async () => { await saveSettings({ contentProtection: !settings.contentProtection }); renderGeneral(); };
$("audio-language").onchange = () => rpc("userConfigs/update", { audioInputLanguage: $("audio-language").value });
$("display-language").onchange = () => rpc("userConfigs/update", { displayLanguage: $("display-language").value });
$("quit").onclick = () => (native ? native.send("quit-app") : window.close());

// ---- model: the shared chooser (public/answers.js), mounted the first time the tab opens ------

let answers = null;
function mountModelTab() {
  answers ??= mountAnswers($("answers"), { onChange: (next) => { settings = next; } });
}

// ---- keybinds --------------------------------------------------------------------------------

const keybindRows = [
  ["General", [
    ["toggleVisibility", "monitor", "Toggle visibility of Cue"],
    ["ask", "chat", "Ask Cue about your screen or audio"],
    ["clear", "chat-plus", "Start a new chat"],
    ["openSettings", "gear", "Open Cue settings"],
    ["toggleSession", "mic", "Start or stop a Cue session"],
  ]],
  ["Window", [
    ["moveUp", "up", "Move the window position up"],
    ["moveDown", "down", "Move the window position down"],
    ["moveLeft", "left", "Move the window position left"],
    ["moveRight", "right", "Move the window position right"],
  ]],
];
const keyGlyphs = { CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Enter: "↵", Return: "↵", Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "␣", Backspace: "⌫", Tab: "⇥" };
const glyphs = (accelerator) => accelerator.split(/\+(?!$)/).map((part) => keyGlyphs[part] || part);
let recording = null;

function renderKeybinds(errors = {}) {
  const nodes = [];
  for (const [group, rows] of keybindRows) {
    nodes.push(el("div", "kb-group", group));
    for (const [action, iconName, label] of rows) {
      const row = el("div", "kb-row", `${icon(iconName)}<span class="label">${label}</span>`);
      if (errors[action]) row.append(el("span", "kb-error", errors[action]));
      const keys = el("button", `keys${recording === action ? " recording" : ""}`);
      keys.title = "Click, then press the new shortcut (Esc cancels)";
      if (recording === action) keys.append(el("span", "hint", "Press keys…"));
      else for (const glyph of glyphs(settings.shortcuts[action])) keys.append(el("kbd", "", escapeText(glyph)));
      keys.onclick = () => { recording = recording === action ? null : action; renderKeybinds(); };
      row.append(keys);
      nodes.push(row);
    }
  }
  const reset = el("button", "link", "Reset to defaults");
  reset.style.marginTop = "18px";
  reset.onclick = async () => { recording = null; await saveSettings({ shortcuts: settings.defaultShortcuts }); renderKeybinds(); };
  nodes.push(reset);
  $("keybinds").replaceChildren(...nodes);
}

const codeKeys = { Backslash: "\\", Slash: "/", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", Enter: "Enter", Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Tab: "Tab", Backspace: "Backspace" };
function acceleratorFrom(event) {
  let key = codeKeys[event.code];
  if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  if (!key && /^Digit\d$/.test(event.code)) key = event.code.slice(5);
  if (!key && /^F\d{1,2}$/.test(event.code)) key = event.code;
  if (!key) return null;
  const mods = [event.metaKey && "CommandOrControl", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return null; // a bare key would fire while typing anywhere
  return [...mods, key].join("+");
}
window.addEventListener("keydown", async (event) => {
  if (!recording) return;
  event.preventDefault();
  if (event.key === "Escape") { recording = null; return renderKeybinds(); }
  const accelerator = acceleratorFrom(event);
  if (!accelerator) return;
  const action = recording;
  const previous = settings.shortcuts[action];
  recording = null;
  const failed = await saveSettings({ shortcuts: { [action]: accelerator } });
  if (failed.includes(action)) {
    await saveSettings({ shortcuts: { [action]: previous } });
    return renderKeybinds({ [action]: `${glyphs(accelerator).join("")} is taken by another app` });
  }
  renderKeybinds();
}, true);

// ---- audio -----------------------------------------------------------------------------------

async function listMics() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default");
  const select = $("mic-device");
  select.replaceChildren(el("option", "", "System default"), ...devices.map((d, i) => {
    const option = el("option", "", escapeText(d.label || `Microphone ${i + 1}`));
    option.value = d.deviceId;
    return option;
  }));
  select.firstChild.value = "";
  select.value = settings.micDeviceId && devices.some((d) => d.deviceId === settings.micDeviceId) ? settings.micDeviceId : "";
  $("mic-desc").textContent = devices.some((d) => d.label) ? "Used for your side of the conversation." : "Press Test Microphone once to see device names.";
}
$("mic-device").onchange = () => saveSettings({ micDeviceId: $("mic-device").value || null });

let meter = null;
$("mic-test").onclick = async () => {
  if (meter) return meter.stop();
  const deviceId = $("mic-device").value;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame;
  const draw = () => {
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
    $("meter-fill").style.width = `${Math.min(100, rms * 400)}%`;
    window.__cueMicLevel = rms; // read by scripts/drive.mjs
    frame = requestAnimationFrame(draw);
  };
  draw();
  $("mic-test").textContent = "Stop";
  const timeout = setTimeout(() => meter?.stop(), 15000);
  meter = {
    stop() {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      stream.getTracks().forEach((t) => t.stop());
      context.close();
      $("meter-fill").style.width = "0";
      $("mic-test").textContent = "Test Microphone";
      meter = null;
    },
  };
  listMics();
};

// ---- about -----------------------------------------------------------------------------------

let statusTimer = null;
async function pollStatus() {
  clearTimeout(statusTimer);
  if (!document.querySelector('.page[data-page="about"]').classList.contains("active")) return;
  // Re-read: the Model tab may have changed the backend since this page loaded.
  settings = await rpc("settings/get");
  const where = {
    local: ["llama.cpp", settings.info.localModel],
    claude: ["Claude Code CLI", settings.claudeModel],
    anthropic: ["Anthropic API", settings.claudeModel],
    openai: ["OpenAI API", settings.openaiModel],
    compatible: [settings.compatibleBaseUrl || "Endpoint", settings.compatibleModel],
  }[settings.llmBackend];
  $("version").textContent = `Version ${settings.info.version} · ${where[1]}${settings.llmBackend === "local" ? ` · ${settings.info.imageTokens} vision tokens per screenshot` : ""}`;
  try {
    const status = await rpc("settings/status");
    const show = (key, label, where) => {
      const up = ["up", "signed in", "mock", "key set", "configured"].includes(status[key]);
      $(`dot-${key}`).className = `dot ${up ? "up" : "down"}`;
      $(`status-${key}`).textContent = `${label}: ${status[key]}${where ? ` · ${where}` : ""}`;
    };
    show("chat", where[0], settings.llmBackend === "local" ? settings.info.llmBaseUrl : "");
    show("asr", settings.asrBackend === "local" ? "whisper.cpp" : "OpenAI", settings.info.asrBaseUrl);
  } catch (error) {
    $("status-chat").textContent = error.message;
  }
  statusTimer = setTimeout(pollStatus, 3000);
}

// ---- modes -----------------------------------------------------------------------------------

const templateIcons = { interview: "chat", behavioralInterview: "chat", codingInterview: "keyboard", systemDesign: "cpu", lecture: "file", sales: "sparkles", recruiting: "chat", teamMeet: "chat", caseInterview: "gauge", recruiterScreen: "chat" };
let modes = [];
let templates = [];
let selected = { kind: "general" };
let saveTimer = null;

async function loadModes() {
  [modes, templates] = await Promise.all([rpc("modes/list").then((r) => r.items), rpc("modes/templates").then((r) => r.items)]);
}

async function renderModeList() {
  await loadModes();
  const owned = new Set(modes.map((m) => m.templateKey).filter(Boolean));
  const activeId = modes.find((m) => m.isActive)?.id;
  const row = (name, iconName, sel, isActive, onclick, extra = "") => {
    const button = el("button", `m-row ${extra}${sel ? " selected" : ""}`, `<span class="mbox">${icon(iconName)}</span><span class="name">${escapeText(name)}</span>${isActive ? `<span class="badge">${icon("check")}</span>` : ""}`);
    button.onclick = onclick;
    return button;
  };
  const nodes = [
    row("New Mode", "plus", false, false, createMode, "new"),
    row("General", "file", selected.kind === "general", !activeId, () => select({ kind: "general" })),
  ];
  if (modes.length) nodes.push(el("div", "m-section", "Your modes"));
  for (const mode of modes) nodes.push(row(mode.name, templateIcons[mode.templateKey] || "chat", selected.kind === "mode" && selected.id === mode.id, mode.isActive, () => select({ kind: "mode", id: mode.id })));
  const left = templates.filter((t) => !owned.has(t.templateKey));
  if (left.length) nodes.push(el("div", "m-section", "Templates"));
  for (const t of left) nodes.push(row(t.name, templateIcons[t.templateKey] || "chat", selected.kind === "template" && selected.key === t.templateKey, false, () => select({ kind: "template", key: t.templateKey })));
  $("mode-list").replaceChildren(...nodes);
  renderEditor();
}

function select(next) {
  flushSave();
  selected = next;
  renderModeList();
}

function current() {
  if (selected.kind === "mode") return modes.find((m) => m.id === selected.id);
  if (selected.kind === "template") return templates.find((t) => t.templateKey === selected.key);
  return null;
}

function renderEditor() {
  const item = current();
  const general = selected.kind === "general" || !item;
  const activeId = modes.find((m) => m.isActive)?.id;
  $("mode-name").value = general ? "General" : item.name;
  $("mode-name").readOnly = general;
  $("mode-about").textContent = general
    ? "The default mode. No custom prompt or attached files: Cue uses its baseline behaviour. Set this active to clear any mode you have selected."
    : selected.kind === "template" ? "A built-in template. Edit it or set it active to save it as your own mode." : "";
  $("mode-fields").hidden = general;
  if (!general) {
    if (document.activeElement !== $("mode-prompt")) $("mode-prompt").value = item.chatPrompt || "";
    $("mode-files").replaceChildren(...(item.files || []).map((file) => {
      const fileRow = el("div", "file-row", `${icon("file")}<span class="fname">${escapeText(file.name)}</span>`);
      const remove = el("button", "", icon("x"));
      remove.title = "Remove file";
      remove.onclick = async () => { await rpc("modeFiles/delete", { modeId: item.id, id: file.id }); renderModeList(); };
      fileRow.append(remove);
      return fileRow;
    }));
  }
  const isActive = general ? !activeId : selected.kind === "mode" && item.isActive;
  $("mode-activate").textContent = isActive ? (general ? "Active" : "Deactivate") : "Set Active";
  $("mode-activate").classList.toggle("done", isActive);
  $("mode-delete").hidden = selected.kind !== "mode";
}

// A template turns into the person's own mode the first time it is edited or activated.
async function ensureOwnMode() {
  if (selected.kind === "mode") return current();
  const template = current();
  const mode = await rpc("modes/create", { name: $("mode-name").value || template.name, chatPrompt: $("mode-prompt").value, templateKey: template.templateKey });
  selected = { kind: "mode", id: mode.id };
  await loadModes();
  return modes.find((m) => m.id === mode.id);
}

async function createMode() {
  flushSave();
  const mode = await rpc("modes/create", { name: "Untitled Mode", chatPrompt: "" });
  selected = { kind: "mode", id: mode.id };
  await renderModeList();
  $("mode-name").focus();
  $("mode-name").select();
}

function scheduleSave() {
  if (selected.kind === "general") return;
  clearTimeout(saveTimer);
  $("mode-saved").textContent = "Editing…";
  saveTimer = setTimeout(saveMode, 600);
}
function flushSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveMode(); } }
async function saveMode() {
  saveTimer = null;
  const mode = await ensureOwnMode();
  await rpc("modes/update", { id: mode.id, name: $("mode-name").value.trim() || "Untitled Mode", chatPrompt: $("mode-prompt").value });
  $("mode-saved").textContent = "Saved";
  await renderModeList();
}
$("mode-name").oninput = scheduleSave;
$("mode-prompt").oninput = scheduleSave;

$("mode-activate").onclick = async () => {
  flushSave();
  if (selected.kind === "general") await rpc("modes/setAllInactive");
  else {
    const mode = await ensureOwnMode();
    if (mode.isActive) await rpc("modes/setAllInactive");
    else await rpc("modes/setActive", { id: mode.id });
  }
  await native?.invoke("settings-changed", settings).catch(() => {}); // the overlay refreshes its mode icon
  renderModeList();
};
$("mode-delete").onclick = async () => {
  const mode = current();
  if (!mode || !confirm(`Delete "${mode.name}"?`)) return;
  await rpc("modes/delete", { id: mode.id });
  selected = { kind: "general" };
  await native?.invoke("settings-changed", settings).catch(() => {});
  renderModeList();
};

async function uploadFile(file) {
  const mode = await ensureOwnMode();
  const contentType = file.type || "application/octet-stream";
  const { storageKey, uploadUrl } = await rpc("storage/generateUploadUrl", { contentType });
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file });
  if (!put.ok) throw new Error((await put.json().catch(() => ({})))?.json?.message || `Upload failed (${put.status})`);
  await rpc("modeFiles/create", { modeId: mode.id, name: file.name, storageKey, contentType });
  $("mode-saved").textContent = `Added ${file.name}`;
  await renderModeList();
}
$("mode-file").onchange = async (event) => {
  for (const file of event.target.files) await uploadFile(file).catch((error) => ($("mode-saved").textContent = error.message));
  event.target.value = "";
};
const drop = $("dropzone");
drop.ondragover = (event) => { event.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = async (event) => {
  event.preventDefault();
  drop.classList.remove("over");
  for (const file of event.dataTransfer.files) await uploadFile(file).catch((error) => ($("mode-saved").textContent = error.message));
};

// ---- boot ------------------------------------------------------------------------------------

(async () => {
  settings = await rpc("settings/get");
  const user = await rpc("userConfigs/get").catch(() => ({}));
  $("audio-language").value = user.audioInputLanguage || "auto";
  $("display-language").value = user.displayLanguage || "auto";
  renderGeneral();
  mountPermissions($("permission-rows"));
  renderKeybinds();
  showTab(location.hash.slice(1) || "general");
})();
