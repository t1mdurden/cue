import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RpcError, validationError } from "./errors.js";
import { complete } from "./providers.js";
import { loadAtRestKey, openString, sealString } from "./atrest.js";

const iso = () => new Date().toISOString();

function requireString(value, name) {
  if (typeof value !== "string") {
    throw validationError({ [name]: ["Invalid input: expected string"] });
  }
  return value;
}

// Screenshots, partial audio and in-flight request ids are per-turn and never persisted.
const transientRoomFields = () => ({ screenshots: new Map(), partialAudio: new Map(), activeRequestIds: new Set() });

export class Store {
  constructor(file = null) {
    this.file = file;
    this.users = new Map();
    this.rooms = new Map();
    this.uploads = new Map();
    // Upload slots this server minted (storage/generateUploadUrl); PUT /uploads accepts only these.
    this.issuedUploads = new Set();
    // App-wide settings for this machine (one person runs Cue); saved values override env defaults.
    this.settings = {};
    this.saveTimer = null;
    this.atRestKey = file ? loadAtRestKey(file) : null;
    this.warnedNoKey = false;
    // API keys typed into Settings when there is no at-rest key to seal them with: this run only.
    this.memoryKeys = {};
    if (file) this.load();
  }

  load() {
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error(`Cannot read ${this.file}: ${error.message}`);
    }
    this.settings = snapshot.settings || {};
    for (const user of snapshot.users || []) this.users.set(user.id, unsealUser(user, this.atRestKey));
    for (const room of snapshot.rooms || []) this.rooms.set(room.name, { ...unsealRoom(room, this.atRestKey), ...transientRoomFields() });
  }

  // Debounced, and written to a temp file then renamed so a crash mid-write never leaves a
  // half-written store behind.
  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const sealable = Boolean(this.atRestKey);
    if (!sealable && !this.warnedNoKey) {
      this.warnedNoKey = true;
      console.error("[atrest] no key: saving without transcripts, room messages and mode-file text");
    }
    const rooms = [...this.rooms.values()].map(({ screenshots, partialAudio, activeRequestIds, ...room }) => sealRoom(room, this.atRestKey));
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ settings: this.settings, users: [...this.users.values()].map((user) => sealUser(user, this.atRestKey)), rooms }));
    renameSync(tmp, this.file);
  }

  user(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        id: userId,
        // Answers follow the question's language and speech is transcribed in whatever language it is.
        config: { displayLanguage: "auto", audioInputLanguage: "auto" },
        modes: [],
        tags: [],
        sessions: [],
      });
    }
    return this.users.get(userId);
  }

  createRoom({ userId, sessionId = null, isMobile = false }) {
    const name = randomUUID();
    this.rooms.set(name, {
      name,
      ownerUserId: userId,
      sessionId,
      isMobile,
      promptCacheKey: randomUUID(),
      messages: [],
      lastHeartbeatAt: iso(),
      ...transientRoomFields(),
    });
    return name;
  }

  room(name) {
    return this.rooms.get(name);
  }

  // API keys are sealed into settings.apiKeys like conversation content: never plain text on disk.
  // Without an at-rest key they live in memory for this run and the caller says so.
  setApiKey(name, value) {
    const sealed = { ...this.settings.apiKeys };
    delete sealed[name];
    delete this.memoryKeys[name];
    if (value && this.atRestKey) sealed[name] = sealString(this.atRestKey, value);
    else if (value) this.memoryKeys[name] = value;
    this.settings = { ...this.settings, apiKeys: sealed };
  }

  openApiKeys() {
    const open = { ...this.memoryKeys };
    for (const [name, sealed] of Object.entries(this.settings.apiKeys || {})) {
      try { if (this.atRestKey) open[name] = openString(this.atRestKey, sealed); } catch { /* sealed with another key */ }
    }
    return open;
  }

  createAmbientChatAgent(user, { isMobile = false } = {}) {
    return { chatAgentName: this.createRoom({ userId: user.id, isMobile }) };
  }

  createSession(user, { meetingId } = {}) {
    const id = randomUUID();
    const chatAgentName = this.createRoom({ userId: user.id, sessionId: id });
    const session = {
      id,
      meetingId: meetingId ?? null,
      chatAgentName,
      audioInputLanguage: user.config.audioInputLanguage,
      transcript: [],
      createdAt: iso(),
      endedAt: null,
      title: meetingId ? "Meeting session" : "Audio session",
      summary: "",
      state: "active",
      tags: [],
      attendees: [],
      messagesLength: 0,
    };
    this.room(chatAgentName).sessionId = id;
    user.sessions.unshift(session);
    return session;
  }

  resumeSession(user, id) {
    const session = user.sessions.find((s) => s.id === id);
    if (!session) throw new Rpc404("Session not found");
    let room = this.room(session.chatAgentName);
    if (!room) {
      session.chatAgentName = this.createRoom({ userId: user.id, sessionId: id });
      room = this.room(session.chatAgentName);
    }
    room.messages = [];
    return {
      ...session,
      transcript: session.transcript.filter((t) => t.status === "ready"),
    };
  }

  endSession(user, id, transcript = []) {
    const session = user.sessions.find((s) => s.id === id);
    if (!session) throw new Rpc404("Session not found");
    session.transcript = transcript.filter((t) => t.status === "ready");
    session.endedAt = iso();
    session.state = "analyzing";
    // Title and summary come from the model, server-side. The request returns immediately; the
    // client polls sessions/waitFor for finished.
    this.analyzeSession(session).catch((error) => {
      console.error("[analyze]", error.message);
      session.title = session.title === "Audio session" ? "Session" : session.title;
      session.summary = summarizeTranscript(session.transcript);
      session.state = "finished";
      this.save();
    });
    return session;
  }

  async analyzeSession(session) {
    const ready = session.transcript.filter((t) => t.status === "ready" && typeof t.text === "string" && t.text);
    if (!ready.length) {
      session.summary = "";
      session.state = "finished";
      this.save();
      return;
    }
    const body = ready.map((t) => `${t.role === "me" ? "Me" : "Them"}: ${t.text}`).join("\n").slice(-6000);
    const raw = await complete({
      system: "You label a meeting transcript. Reply with a JSON object {\"title\": string, \"summary\": string}. The title is at most 6 words. The summary is 1-3 sentences. No markdown, no code fences.",
      prompt: body,
    });
    const parsed = safeJson(raw);
    session.title = (parsed.title || "Session").toString().slice(0, 80).trim() || "Session";
    session.summary = (parsed.summary || summarizeTranscript(session.transcript)).toString().trim();
    session.state = "finished";
    this.save();
  }

  updateSession(user, input = {}) {
    const session = user.sessions.find((s) => s.id === input.id);
    if (!session) throw new Rpc404("Session not found");
    if (Array.isArray(input.transcript)) session.transcript = input.transcript;
    if (typeof input.title === "string") session.title = input.title;
    return session;
  }

  modes(user) {
    return user.modes;
  }

  createTag(user, { name, color = "#6b7280" } = {}) {
    const tag = { id: randomUUID(), name: name || "Tag", color };
    user.tags.push(tag);
    return tag;
  }

  deleteTag(user, id) {
    user.tags = user.tags.filter((tag) => tag.id !== id);
    for (const session of user.sessions) session.tags = session.tags.filter((tag) => tag.id !== id);
    return { ok: true };
  }

  addSessionTag(user, { sessionId, tagId } = {}) {
    const session = user.sessions.find((item) => item.id === sessionId);
    const tag = user.tags.find((item) => item.id === tagId);
    if (!session || !tag) throw new Rpc404("Session or tag not found");
    if (!session.tags.some((item) => item.id === tag.id)) session.tags.push(tag);
    return { ok: true };
  }

  deleteSessionTag(user, { sessionId, tagId } = {}) {
    const session = user.sessions.find((item) => item.id === sessionId);
    if (session) session.tags = session.tags.filter((tag) => tag.id !== tagId);
    return { ok: true };
  }

  activeMode(user) {
    return user.modes.find((m) => m.isActive) || null;
  }

  createMode(user, input = {}) {
    const mode = {
      id: randomUUID(),
      name: input.name ?? "Untitled Mode",
      chatPrompt: input.chatPrompt ?? "",
      templateKey: input.templateKey ?? null,
      isActive: false,
      files: [],
      createdAt: iso(),
      updatedAt: iso(),
    };
    user.modes.unshift(mode);
    return mode;
  }

  mode(user, id) {
    const mode = user.modes.find((m) => m.id === id);
    if (!mode) throw new Rpc404("Mode not found");
    return mode;
  }

  setActiveMode(user, id) {
    for (const mode of user.modes) mode.isActive = mode.id === id;
    return { ok: true };
  }

  setAllModesInactive(user) {
    for (const mode of user.modes) mode.isActive = false;
    return { ok: true };
  }

  generateUploadUrl(contentType = "application/octet-stream") {
    const storageKey = `modes/${randomUUID()}`;
    this.issuedUploads.add(storageKey);
    return {
      storageKey,
      uploadUrl: `/uploads/${encodeURIComponent(storageKey)}?content_type=${encodeURIComponent(contentType)}`,
    };
  }
}

class Rpc404 extends RpcError {
  constructor(message) {
    super({ code: "NOT_FOUND", status: 404, message, data: {} });
  }
}

function safeJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
}

function summarizeTranscript(transcript) {
  const ready = transcript.filter((t) => t.status === "ready" && typeof t.text === "string" && t.text);
  if (!ready.length) return "";
  return ready.slice(-12).map((t) => `${t.role}: ${t.text}`).join("\n");
}

// ---- conversation content is sealed in the snapshot, opened on load --------------------------
// Each protected string is stored as { $cue: "cue1.<iv|tag|ciphertext>" } (AES-256-GCM, key from
// src/atrest.js). Without a key the fields are dropped rather than written as plain text; titles,
// settings and tags stay readable so History and Settings work from the snapshot alone.

function sealText(key, text) {
  if (typeof text !== "string" || !text) return text;
  return { $cue: sealString(key, text) };
}

function sealUser(user, key) {
  const sealable = Boolean(key);
  return {
    ...user,
    modes: user.modes.map((mode) => ({ ...mode, files: mode.files.map((file) => ({ ...file, text: sealable ? sealText(key, file.text) : undefined })) })),
    sessions: user.sessions.map((session) => ({
      ...session,
      summary: sealable ? sealText(key, session.summary) : undefined,
      transcript: sealable ? session.transcript.map((entry) => ({ ...entry, text: sealText(key, entry.text) })) : [],
    })),
  };
}

function sealRoom(room, key) {
  if (!key) return { ...room, messages: [] };
  return {
    ...room,
    messages: room.messages.map((message) => ({
      ...message,
      content: typeof message.content === "string" ? sealText(key, message.content) : message.content,
      displayText: typeof message.displayText === "string" ? sealText(key, message.displayText) : message.displayText,
      parts: (message.parts || []).map((part) => part.type === "text" ? { ...part, text: sealText(key, part.text) } : part),
    })),
  };
}

function openText(key, value) {
  if (!value || typeof value !== "object" || typeof value.$cue !== "string") return value;
  try {
    return openString(key, value.$cue);
  } catch {
    // Keep the sealed blob: blanking it here would let the next save overwrite the original
    // ciphertext, so a key-rotation mistake would destroy the data instead of delaying it.
    console.error("[atrest] a field does not decrypt with the current key; keeping it sealed");
    return value;
  }
}

function unsealUser(user, key) {
  return {
    ...user,
    modes: (user.modes || []).map((mode) => ({ ...mode, files: (mode.files || []).map((file) => ({ ...file, text: openText(key, file.text) ?? "" })) })),
    sessions: (user.sessions || []).map((session) => ({
      ...session,
      summary: openText(key, session.summary) ?? "",
      transcript: (session.transcript || []).map((entry) => ({ ...entry, text: openText(key, entry.text) ?? "" })),
    })),
  };
}

function unsealRoom(room, key) {
  return {
    ...room,
    messages: (room.messages || []).map((message) => ({
      ...message,
      content: openText(key, message.content) ?? message.content,
      displayText: openText(key, message.displayText) ?? message.displayText,
      parts: (message.parts || []).map((part) => part.type === "text" ? { ...part, text: openText(key, part.text) ?? "" } : part),
    })),
  };
}
