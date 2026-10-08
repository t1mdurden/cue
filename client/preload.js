// The renderer gets a narrow IPC surface, not raw ipcRenderer: every channel is allowlisted per
// direction, so a compromised renderer page cannot reach arbitrary main-process listeners (or
// ones a future feature adds). New channels must be added here on purpose.
const { contextBridge, ipcRenderer } = require("electron");

const SEND_CHANNELS = new Set(["open-settings", "open-setup", "setup-done", "relaunch", "session-start", "session-end", "quit-app"]);
const INVOKE_CHANNELS = new Set(["overlay-resize", "settings-changed", "capture-screenshot", "permissions", "permission-request"]);
const EVENT_CHANNELS = new Set(["settings-changed", "settings-tab", "hotkey", "hotkey-error", "chat-audio-data"]);

const inSet = (set, channel) => {
  if (typeof channel !== "string" || !set.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
};

contextBridge.exposeInMainWorld("ipcRenderer", {
  on(channel, listener) {
    inSet(EVENT_CHANNELS, channel);
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  send(channel, value) {
    inSet(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, value);
  },
  invoke(channel, ...args) {
    inSet(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, ...args);
  },
});

contextBridge.exposeInMainWorld("platform", process.platform);
