import { renderMarkdown } from "/markdown.js";
import { createAudioPipeline, captureMicrophone, pcm16ToFloat32, base64 } from "/audio.js";

const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
const native = window.ipcRenderer || null; // present only inside the Electron shell
const HEIGHTS = { home: 104, chat: 500, history: 760 };

const state = {
  token: localStorage.getItem("cue.token") || "dev-token",
  screenUse: localStorage.getItem("cue.screen") !== "0",
  view: "home",
  room: null,
  socket: null,
  session: null,
  transcript: [],
  turns: [],          // { role, text, el } for the model's own history
  activeRequest: null, // id of the chat request whose chunks are being shown
  audio: null,
  stopMic: null,
  history: [],
  selected: 0,
};

const serverConfig = fetch("/config").then((r) => r.json()).catch(() => ({}));

// ---- view state + window size ----------------------------------------------------------------

async function setView(view) {
  const menuOpen = !els["modes-menu"].hidden;
  const height = HEIGHTS[view] + (menuOpen ? 8 + els["modes-menu"].offsetHeight : 0);
  const growing = height > window.innerHeight;
  // Grow the window before showing taller content and shrink it after, so nothing is clipped.
  if (growing) await resizeWindow(height);
  state.view = view;
  els.panel.dataset.state = view;
  document.documentElement.style.setProperty("--panel-h", `${HEIGHTS[view]}px`);
  if (!growing) await resizeWindow(height);
  if (view === "history") refreshHistory().catch((error) => setStatus(error.message, true));
  if (view === "chat") scrollMessages();
  updateFieldHint();
}

function resizeWindow(height) {
  return native?.invoke("overlay-resize", { height }).catch(() => {});
}

// ---- controls --------------------------------------------------------------------------------

setScreenUse(state.screenUse);
els.send.onclick = () => submitChat();
els["chat-input"].onkeydown = (event) => {
  if (state.view === "history") {
    if (event.key === "Enter") { event.preventDefault(); openSelected(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveSelection(event.key === "ArrowDown" ? 1 : -1); }
    if (event.key === "Escape") setView("home");
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitChat(); }
  if (event.key === "Escape") setView("home");
};
els["chat-input"].oninput = () => {
  autosize();
  if (state.view === "history") renderHistory();
};
els["chat-input"].onfocus = els["chat-input"].onblur = updateFieldHint;
els.back.onclick = () => { els["chat-input"].value = ""; setView("home"); };
els["back-to-chat"].onclick = () => setView("chat");
els["history-btn"].onclick = () => { els["chat-input"].value = ""; setView("history"); };
els["new-chat"].onclick = els["history-new-chat"].onclick = () => clearConversation();
els["open-session"].onclick = () => openSelected();
els["screen-use"].onclick = () => setScreenUse(!state.screenUse);
els.detectable.onclick = () => setProtected(!state.protected);
els["modes-btn"].onclick = () => toggleModesMenu();
els["settings-btn"].onclick = () => openSettings();
els.listen.onclick = () => (state.session ? endSession() : startSession());
els["notice-continue"].onclick = () => { state.lastActivityAt = Date.now(); hideNotice(); };

// Hotkeys from the Electron main process (globalShortcut) and local fallbacks for the browser.
native?.on("hotkey", (name) => hotkey(name));
native?.on("hotkey-error", (text) => setStatus(text, true));
native?.on("settings-changed", (settings) => applySettings(settings));
// Signing in from Settings changes no setting, so a shown warning is re-checked when the overlay
// gets focus again.
window.addEventListener("focus", () => { if (state.signInWarning) checkSignIn(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && document.activeElement !== els["chat-input"]) { event.preventDefault(); els["chat-input"].focus(); return; }
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === "Enter") { event.preventDefault(); submitChat(); }
  else if (event.key === "\\" && event.shiftKey) { event.preventDefault(); els.listen.onclick(); }
  else if (event.key === "," && !native) { event.preventDefault(); openSettings(); }
  else if (event.key.toLowerCase() === "r" && !native) { event.preventDefault(); clearConversation(); }
});
document.addEventListener("pointerdown", (event) => {
  if (!els["modes-menu"].hidden && !els["modes-menu"].contains(event.target) && !els["modes-btn"].contains(event.target)) toggleModesMenu(false);
});
function hotkey(name) {
  if (name === "ask") submitChat();
  if (name === "toggleSession") els.listen.onclick();
  if (name === "clear") clearConversation();
  if (name === "openSettings") openSettings();
}

function openSettings(tab) {
  if (native) native.send("open-settings", tab);
  else window.open(`/settings.html${tab ? `#${tab}` : ""}`, "cue-settings", "width=920,height=670");
}

function autosize() {
  const input = els["chat-input"];
  input.style.height = "22px";
  input.style.height = `${Math.min(input.scrollHeight, 66)}px`;
}

function updateFieldHint() {
  const idle = state.view === "chat" && document.activeElement !== els["chat-input"] && !els["chat-input"].value;
  els.field.classList.toggle("idle", idle);
  els["chat-input"].placeholder = state.signInWarning || (state.view === "chat" ? "Ask a follow-up" : "Ask about your screen or the call");
  els["back-to-chat"].hidden = !(state.view === "home" && state.turns.length);
}

async function rpc(procedure, input = {}) {
  const response = await fetch(`/rpc/${procedure}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ json: input, meta: [] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.json?.message || response.statusText);
  return body.json;
}

// ---- agent room / chat -----------------------------------------------------------------------

function connect(room) {
  if (state.room === room && state.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  state.room = room;
  state.socket?.close();
  document.cookie = "__client_uat=1; path=/; SameSite=Lax";
  const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/agents/chat-agent/${room}?_pk=${crypto.randomUUID()}`);
  state.socket = socket;
  socket.onclose = () => { if (state.socket === socket) { state.socket = null; setStatus("Agent disconnected"); } };
  socket.onmessage = (event) => handleAgentMessage(JSON.parse(event.data));
  return new Promise((resolve, reject) => {
    socket.onopen = () => { setStatus(""); resolve(); };
    socket.onerror = () => reject(new Error("Could not reach the agent"));
  });
}

function handleAgentMessage(message) {
  if (message.type !== "cf_agent_use_chat_response") return;
  // Only the newest request's chunks reach the screen; an answer that was superseded keeps what it
  // had streamed so far.
  if (message.id !== state.activeRequest) return;
  let chunk;
  try { chunk = JSON.parse(message.body); } catch { return; }
  const current = state.turns.at(-1);
  if (!current?.streaming) return;
  if (chunk.type === "start") current.el.classList.remove("waiting");
  if (chunk.type === "text-delta") {
    if (window.__cueTiming && !window.__cueTiming.firstToken) window.__cueTiming.firstToken = performance.now();
    current.el.classList.remove("waiting");
    current.text += chunk.delta;
    current.body.innerHTML = renderMarkdown(current.text);
    scrollMessages();
  }
  if (chunk.type === "error") {
    setStatus(chunk.errorText, true);
    current.el.classList.remove("waiting");
    if (!current.text) { current.text = `_${chunk.errorText}_`; current.body.innerHTML = renderMarkdown(current.text); }
  }
  if (chunk.type === "finish" || message.done) finishTurn(current);
}

function finishTurn(turn) {
  turn.streaming = false;
  turn.el.classList.remove("waiting");
  if (turn.text && !turn.el.querySelector(".copy")) {
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.title = "Copy response";
    copy.innerHTML = '<svg><use href="#i-copy"/></svg>';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(turn.text);
      copy.innerHTML = '<svg><use href="#i-check"/></svg>';
      setTimeout(() => (copy.innerHTML = '<svg><use href="#i-copy"/></svg>'), 1200);
    };
    turn.el.append(copy);
  }
}

async function ensureRoom() {
  if (state.socket?.readyState === WebSocket.OPEN) return;
  if (state.session) return connect(state.session.chatAgentName);
  const { chatAgentName } = await rpc("sessions/createAmbientChatAgent", { isMobile: false });
  await connect(chatAgentName);
}

function socketCall(method, input) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "rpc" || message.id !== id) return;
      state.socket.removeEventListener("message", listener);
      message.success ? resolve(message.result) : reject(new Error(message.error));
    };
    state.socket.addEventListener("message", listener);
    state.socket.send(JSON.stringify({ id, type: "rpc", method, args: [input] }));
  });
}

async function submitChat() {
  const timing = { pressed: performance.now() };
  window.__cueTiming = timing; // read by scripts/drive.mjs to measure the overlay's own overhead
  const typed = els["chat-input"].value.trim();
  const displayText = typed || "Assist";
  const request = typed || (state.session
    ? "Help me with the conversation right now: answer what was just asked, or tell me what to say next."
    : "Look at my screen and tell me what would help me most right now.");
  els["chat-input"].value = "";
  autosize();
  toggleModesMenu(false);
  const viewChange = state.view === "chat" ? null : setView("chat");

  try {
    await ensureRoom();
  } catch (error) {
    return setStatus(error.message, true);
  }

  // A question asked while the previous answer streams replaces it.
  const previous = state.turns.at(-1);
  if (previous?.streaming) {
    state.socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: state.activeRequest }));
    state.activeRequest = null; // the cancelled request's late chunks (its finish) must not close the new turn
    finishTurn(previous);
    // Replaced before its first word: an empty bubble reads as an answer that came back blank. The
    // turn stays in state.turns, so the history keeps alternating roles.
    if (!previous.text) previous.el.remove();
  }

  const messageId = crypto.randomUUID();
  const sinceCreatedAt = state.turns.findLast((turn) => turn.sinceCreatedAt)?.sinceCreatedAt ?? null;
  const fresh = state.transcript.filter((t) => t.status === "ready" && (!sinceCreatedAt || t.createdAt > sinceCreatedAt));
  const hidden = [
    `<screen_use>\nCurrent preference: ${state.screenUse ? "required" : "off"}\n</screen_use>`,
    fresh.length ? `<audio_transcript>\n${fresh.map((t) => `- ${t.role === "me" ? "Me" : "Them"}: ${t.text}`).join("\n")}\n</audio_transcript>` : null,
    request,
  ].filter(Boolean).join("\n\n");

  const lastReady = state.transcript.filter((t) => t.status === "ready").at(-1)?.createdAt ?? null;
  const userMessage = { id: messageId, role: "user", parts: [{ type: "text", text: hidden }], displayText };
  const userTurn = addTurn("user", displayText);
  userTurn.message = userMessage;
  const assistant = addTurn("assistant", "");
  assistant.streaming = true;
  assistant.sinceCreatedAt = lastReady;
  assistant.el.classList.add("waiting");
  setStatus("");

  // The screenshot and any not-yet-transcribed speech go up together; the server transcribes the
  // partial audio while the screenshot is still in flight.
  const attachments = await Promise.allSettled([
    state.screenUse ? uploadScreenshot(messageId).then(() => { timing.screenshot = performance.now(); }) : null,
    state.session ? uploadPartialAudio(messageId).then(() => { timing.audio = performance.now(); }) : null,
  ]);
  const failed = attachments.find((result) => result.status === "rejected");
  if (failed) setStatus(`Attachment failed: ${failed.reason.message}`, true);

  // Earlier turns only: the last two entries are this turn's user bubble and assistant placeholder.
  const history = state.turns
    .slice(0, -2)
    .filter((turn) => turn.text || turn.role === "assistant")
    .map((turn) => turn.role === "user" && turn.message
      ? turn.message
      : { id: crypto.randomUUID(), role: turn.role, parts: [{ type: "text", text: turn.text }] });

  const requestId = crypto.randomUUID().slice(0, 8);
  state.activeRequest = requestId;
  timing.sent = performance.now();
  state.socket.send(JSON.stringify({
    id: requestId,
    type: "cf_agent_use_chat_request",
    init: { method: "POST", body: JSON.stringify({ messages: [...history, userMessage], trigger: "submit-message" }) },
  }));
  await viewChange;
}

function addTurn(role, text) {
  const el = document.createElement("article");
  el.className = `message ${role}`;
  const body = document.createElement("div");
  if (role === "assistant") body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  el.append(body);
  els.messages.append(el);
  scrollMessages();
  const turn = { role, text, el, body };
  state.turns.push(turn);
  return turn;
}

function clearConversation() {
  const current = state.turns.at(-1);
  if (current?.streaming) state.socket?.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: state.activeRequest }));
  state.activeRequest = null;
  state.turns = [];
  els.messages.replaceChildren();
  setStatus("");
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
  if (!state.session) setView("home");
  else updateFieldHint();
}

async function uploadScreenshot(messageId) {
  let bytes;
  let contentType = "image/png";
  if (native) {
    const result = await native.invoke("capture-screenshot", { maxSide: (await serverConfig).screenshotMaxSide });
    bytes = new Uint8Array(result.data);
    contentType = result.contentType;
  } else {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: 1920, height: 1080 } });
    const track = stream.getVideoTracks()[0];
    const bitmap = await new ImageCapture(track).grabFrame();
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  await socketCall("uploadScreenshot", { messageId, dataBase64: base64(bytes), contentType });
}

async function uploadPartialAudio(messageId) {
  const entries = state.audio?.takePending() ?? [];
  if (entries.length) {
    await socketCall("uploadPartialAudio", { messageId, language: state.session.audioInputLanguage, entries });
  }
}

// ---- session / audio -------------------------------------------------------------------------

async function startSession() {
  // A session without the macOS grants records silence or a black screen; Setup asks for them.
  const permissions = await native?.invoke("permissions").catch(() => null);
  const missing = permissions ? ["microphone", "screen", "systemAudio"].filter((kind) => !["granted", "unavailable"].includes(permissions[kind])) : [];
  if (missing.length) {
    const names = { microphone: "Microphone", screen: "Screen Recording", systemAudio: "System Audio Recording" };
    setStatus(`Cue needs ${missing.map((kind) => names[kind]).join(", ")} before a session. Allow ${missing.length > 1 ? "them" : "it"} in the Setup window.`, true);
    native.send("open-setup", "permissions");
    return;
  }
  checkSignIn();
  try {
    state.session = await rpc("sessions/create", {});
  } catch (error) {
    return setStatus(error.message, true);
  }
  state.transcript = [];
  state.turns = [];
  els.messages.replaceChildren();
  renderTranscript();
  await connect(state.session.chatAgentName);
  state.session.createdOrResumedAt = Date.now();
  els.listen.classList.add("live");
  els.listen.title = "Stop listening (Cmd+Shift+\\)";
  startTimer();
  setView("chat");

  const hooks = {
    language: () => state.session?.audioInputLanguage || "auto",
    sessionStartedAt: () => state.session?.createdOrResumedAt || Date.now(),
    transcribe: async (wavBase64Value, language) => (await rpc("transcription/transcribe", { wavBase64: wavBase64Value, language })).text,
    add: (entry) => { state.transcript.push(entry); state.transcript.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); renderTranscript(); },
    ready: (entry, text) => { entry.status = "ready"; entry.text = text; renderTranscript(); syncTranscript(); },
    remove: (entry) => { state.transcript = state.transcript.filter((t) => t !== entry); renderTranscript(); },
  };
  try {
    state.audio = await createAudioPipeline(hooks);
  } catch (error) {
    return setStatus(`Audio init failed: ${error.message}`, true);
  }

  // Mic ("me") is always captured in the renderer. In the Electron shell the main process adds
  // macOS system audio ("them") over chat-audio-data; in a plain browser there is no "them".
  try {
    state.stopMic = await captureMicrophone((samples) => state.audio?.push("me", samples), state.micDeviceId);
  } catch (error) {
    setStatus(`Microphone blocked: ${error.message}`, true);
  }
  if (native) {
    native.send("session-start");
    state.offAudio = native.on("chat-audio-data", ({ role, chunk }) => state.audio?.push(role, pcm16ToFloat32(new Uint8Array(chunk))));
  }
  state.heartbeat = setInterval(() => rpc("sessions/sendHeartbeat", { id: state.session.id }).catch(() => {}), 60000);
  state.syncTimer = setInterval(syncTranscript, 10000);
  watchInactivity();
}

function startTimer() {
  const started = Date.now();
  const tick = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    els.timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  tick();
  state.timerHandle = setInterval(tick, 1000);
}

// Inactivity: six minutes with no new transcript or messages raises a prompt; no answer within
// 40 s ends the session, so a forgotten session does not keep recording.
async function watchInactivity() {
  const timers = await serverConfig;
  const idleMs = timers.inactivityMs ?? 360000;
  const confirmMs = timers.inactivityConfirmMs ?? 40000;
  let lastSize = -1;
  state.lastActivityAt = Date.now();
  state.idleTimer = setInterval(() => {
    if (!state.session) return;
    const size = state.transcript.length + state.turns.length;
    if (size !== lastSize) {
      lastSize = size;
      state.lastActivityAt = Date.now();
      hideNotice();
      return;
    }
    const idle = Date.now() - state.lastActivityAt;
    if (idle >= idleMs + confirmMs) {
      hideNotice();
      endSession();
    } else if (idle >= idleMs && els.notice.hidden) {
      els["notice-text"].textContent = `No activity for a while. Ending the session in ${Math.round(confirmMs / 1000)} s.`;
      els.notice.hidden = false;
      if (state.view !== "chat") setView("chat");
    }
  }, Math.min(1000, idleMs / 4));
}

function hideNotice() {
  els.notice.hidden = true;
}

async function endSession() {
  if (!state.session) return;
  const id = state.session.id;
  clearInterval(state.heartbeat);
  clearInterval(state.syncTimer);
  clearInterval(state.idleTimer);
  clearInterval(state.timerHandle);
  hideNotice();
  native?.send("session-end");
  state.offAudio?.();
  await state.stopMic?.();
  state.stopMic = null;
  state.audio?.stop();
  state.audio = null;
  els.listen.classList.remove("live");
  els.listen.title = "Listen (Cmd+Shift+\\)";
  const session = state.session;
  state.session = null;
  state.socket?.close();
  setStatus("Saving session…");
  try {
    await rpc("sessions/end", { id, transcript: state.transcript.filter((t) => t.status === "ready") });
    await waitForFinished(id);
    setStatus("Session saved to History");
  } catch (error) {
    setStatus(error.message, true);
  }
  ensureRoom().catch(() => {});
}

async function waitForFinished(id) {
  for (let i = 0; i < 20; i++) {
    const result = await rpc("sessions/waitFor", { id, state: "finished" });
    if (result.status === "fulfilled") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function syncTranscript() {
  if (!state.session) return;
  rpc("sessions/update", { id: state.session.id, transcript: state.transcript.filter((t) => t.status === "ready") }).catch(() => {});
}

function renderTranscript() {
  els.transcript.replaceChildren(...state.transcript.map((entry) => {
    const el = document.createElement("div");
    el.className = `entry ${entry.role}${entry.status === "transcribing" ? " pending" : ""}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = entry.role === "me" ? "Me" : "Them";
    el.append(who, document.createTextNode(entry.status === "transcribing" ? "…" : entry.text));
    return el;
  }));
  els.chat.scrollTop = els.chat.scrollHeight;
}

// ---- modes menu ------------------------------------------------------------------------------

async function toggleModesMenu(open = els["modes-menu"].hidden) {
  if (!open) {
    if (els["modes-menu"].hidden) return;
    els["modes-menu"].hidden = true;
    return resizeWindow(HEIGHTS[state.view]);
  }
  let items = [];
  let templates = [];
  try {
    [items, templates] = await Promise.all([rpc("modes/list", {}).then((r) => r.items), rpc("modes/templates", {}).then((r) => r.items)]);
  } catch (error) {
    return setStatus(error.message, true);
  }
  // Built-in templates appear alongside the person's own modes until one is picked, which saves it.
  const owned = new Set(items.map((mode) => mode.templateKey).filter(Boolean));
  const fromTemplate = async (template) => {
    const mode = await rpc("modes/create", { name: template.name, chatPrompt: template.chatPrompt, templateKey: template.templateKey });
    return pickMode(mode.id);
  };
  const active = items.find((mode) => mode.isActive);
  const row = (name, isActive, onclick, extra = "") => {
    const button = document.createElement("button");
    button.className = `menu-item ${extra}`;
    button.setAttribute("role", "menuitemradio");
    button.innerHTML = `<span class="name"></span>${isActive ? '<svg><use href="#i-check"/></svg>' : ""}`;
    button.querySelector(".name").textContent = name;
    button.onclick = onclick;
    return button;
  };
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = "Mode";
  els["modes-menu"].replaceChildren(
    title,
    row("General", !active, () => pickMode(null)),
    ...items.map((mode) => row(mode.name, mode.isActive, () => pickMode(mode.id))),
    ...templates.filter((t) => !owned.has(t.templateKey)).map((t) => row(t.name, false, () => fromTemplate(t))),
    row("Manage modes…", false, () => { toggleModesMenu(false); openSettings("modes"); }, "manage"),
  );
  els["modes-menu"].hidden = false;
  await resizeWindow(HEIGHTS[state.view] + 8 + els["modes-menu"].offsetHeight);
}

async function pickMode(id) {
  try {
    if (id) await rpc("modes/setActive", { id });
    else await rpc("modes/setAllInactive", {});
  } catch (error) {
    setStatus(error.message, true);
  }
  await toggleModesMenu(false);
  refreshActiveMode();
}

async function refreshActiveMode() {
  const { items } = await rpc("modes/list", {});
  const active = items.find((mode) => mode.isActive);
  els["modes-btn"].classList.toggle("on", Boolean(active));
  els["modes-btn"].title = `Mode: ${active?.name || "General"}`;
  els["modes-btn"].setAttribute("aria-label", els["modes-btn"].title);
}

// ---- history ---------------------------------------------------------------------------------

async function refreshHistory() {
  const { items } = await rpc("sessions/list", { limit: 50 });
  state.history = items;
  state.selected = 0;
  renderHistory();
}

function renderHistory() {
  const query = els["chat-input"].value.trim().toLowerCase();
  const items = state.history.filter((s) => !query || `${s.title} ${s.summary || ""}`.toLowerCase().includes(query));
  state.visibleHistory = items;
  state.selected = Math.min(state.selected, Math.max(items.length - 1, 0));
  const nodes = [];
  let day = null;
  items.forEach((session, index) => {
    const created = new Date(session.createdAt);
    const label = created.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" });
    if (label !== day) {
      day = label;
      const header = document.createElement("div");
      header.className = "h-section";
      header.textContent = label;
      nodes.push(header);
    }
    const row = document.createElement("div");
    row.className = `h-row${index === state.selected ? " selected" : ""}`;
    const minutes = session.endedAt ? Math.max(1, Math.round((new Date(session.endedAt) - created) / 60000)) : null;
    row.innerHTML = `<span class="box"><svg><use href="#i-file"/></svg></span><span class="title"></span><span class="chip"></span><span class="time"></span>`;
    row.querySelector(".title").textContent = session.title || "Untitled session";
    row.querySelector(".chip").textContent = minutes ? `${minutes}m` : "Live";
    row.querySelector(".time").textContent = created.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    row.onmouseenter = () => { state.selected = index; markSelected(); };
    row.onclick = () => openPastSession(session.id);
    nodes.push(row);
  });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "h-empty";
    empty.textContent = query ? "No sessions match." : "No sessions yet. Press the waveform to start listening.";
    const header = document.createElement("div");
    header.className = "h-section";
    header.textContent = "Sessions";
    nodes.push(header, empty);
  }
  els["history-list"].replaceChildren(...nodes);
}

function markSelected() {
  [...els["history-list"].querySelectorAll(".h-row")].forEach((row, index) => row.classList.toggle("selected", index === state.selected));
}

function moveSelection(delta) {
  const count = state.visibleHistory?.length || 0;
  if (!count) return;
  state.selected = (state.selected + delta + count) % count;
  markSelected();
  els["history-list"].querySelectorAll(".h-row")[state.selected]?.scrollIntoView({ block: "nearest" });
}

function openSelected() {
  const session = state.visibleHistory?.[state.selected];
  if (session) openPastSession(session.id);
}

async function openPastSession(id) {
  const session = await rpc("sessions/get", { id });
  state.transcript = session.transcript || [];
  renderTranscript();
  state.turns = [];
  els.messages.replaceChildren();
  const messages = await (await fetch(`/agents/chat-agent/${session.chatAgentName}/get-messages`)).json().catch(() => []);
  for (const message of messages) {
    const text = (message.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
    const turn = addTurn(message.role, message.role === "user" ? (message.displayText || "Assist") : text);
    if (message.role === "assistant") finishTurn(turn);
    if (message.role === "assistant" && !text) turn.el.remove(); // replaced before its first word
  }
  els["chat-input"].value = "";
  await setView("chat");
  setStatus(session.summary ? `${session.title}: ${session.summary}` : "");
}

// ---- settings applied in this window --------------------------------------------------------

function setScreenUse(on) {
  state.screenUse = on;
  localStorage.setItem("cue.screen", on ? "1" : "0");
  els["screen-use"].setAttribute("aria-checked", String(on));
  els["screen-use"].title = on ? "Uses screen" : "Does not use screen";
  els["screen-use"].querySelector("use").setAttribute("href", on ? "#i-image" : "#i-image-off");
}

function setProtected(on, { save = true } = {}) {
  state.protected = on;
  els.detectable.setAttribute("aria-checked", String(!on));
  els.detectable.title = on ? "Hidden from screen sharing" : "Visible in screen sharing";
  els.detectable.querySelector("use").setAttribute("href", on ? "#i-eye-off" : "#i-eye");
  if (save) rpc("settings/update", { contentProtection: on }).then((settings) => native?.invoke("settings-changed", settings)).catch((error) => setStatus(error.message, true));
}

function applySettings(settings) {
  if (typeof settings.contentProtection === "boolean") setProtected(settings.contentProtection, { save: false });
  state.micDeviceId = settings.micDeviceId || undefined;
  refreshActiveMode().catch(() => {});
  checkSignIn();
}

// A backend that cannot answer (Claude signed out, no API key, the local model not downloaded or
// still loading) is announced when the overlay opens, when the backend changes and when a session
// starts — never first by a failed answer mid-call.
async function checkSignIn() {
  let status;
  try {
    status = await rpc("settings/status", { fresh: true });
  } catch {
    return; // the server itself is unreachable; the next question reports that
  }
  const { claude, chat, servers } = status;
  const llama = servers?.llama;
  const warning = claude ? (claude.state === "signed-in" ? ""
    : claude.state === "signed-out" ? "Claude is not signed in: answers will fail. Settings → Model → Sign in."
    : claude.state === "missing" ? "The claude CLI is not installed: answers will fail. Settings → Model."
    : claude.state === "outdated" ? "The claude CLI is too old for Cue: answers will fail. Settings → Model."
    : `Could not check the Claude sign-in: ${claude.detail}`)
    : chat === "not chosen" ? "Pick where answers come from first: Settings → Model."
    : chat === "no key" ? "No API key: answers will fail. Settings → Model."
    : chat === "not set" ? "No endpoint chosen: answers will fail. Settings → Model."
    : llama && ["needs-model", "not-installed", "exited"].includes(llama.state) ? `The local model is not ready: ${llama.detail} Settings → Model.`
    : "";
  const previous = state.signInWarning;
  state.signInWarning = warning;
  if (warning) setStatus(warning, true);
  else if (previous && els.status.textContent === previous) setStatus("");
  updateFieldHint();
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
  // On the compact bar there is no body to show a status in, so errors borrow the placeholder.
  if (state.view === "home" && text && isError) {
    els["chat-input"].placeholder = text;
    clearTimeout(state.placeholderTimer);
    state.placeholderTimer = setTimeout(updateFieldHint, 5000);
  }
}

function scrollMessages() { els.chat.scrollTop = els.chat.scrollHeight; }

// Open the ambient room now, not on the first question: the server warms the model for it while the
// overlay sits idle.
ensureRoom().catch(() => {});
rpc("settings/get", {}).then(applySettings).catch(() => { setProtected(true, { save: false }); refreshActiveMode().catch(() => {}); });
updateFieldHint();
