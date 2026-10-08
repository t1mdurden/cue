// The three macOS grants a session needs, as rows with a live status and the one action that fixes
// each. Setup and Settings both mount it; the Electron main process does the asking (client/main.js).
const native = window.ipcRenderer || null;

const ROWS = [
  { kind: "microphone", icon: "mic", title: "Microphone", why: "Your side of the conversation." },
  { kind: "screen", icon: "monitor", title: "Screen Recording", why: "What is on your screen when you ask." },
  { kind: "systemAudio", icon: "wave", title: "System Audio Recording", why: "The other side of the call, from whatever your Mac plays." },
];

export function allGranted(status) {
  return ROWS.every(({ kind }) => status[kind] === "granted" || status[kind] === "unavailable");
}

// Renders into `container` and keeps it current; `onChange(status)` fires after every refresh.
export function mountPermissions(container, onChange = () => {}) {
  if (!native) {
    container.innerHTML = `<p class="sub">In a browser, the browser asks for the microphone itself; screen and system audio need the Cue app.</p>`;
    onChange({ microphone: "granted", screen: "granted", systemAudio: "granted" });
    return () => {};
  }
  let status = null;
  let busy = null;

  const render = () => {
    container.replaceChildren(...ROWS.map(({ kind, icon, title, why }) => {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.permission = kind;
      const value = status[kind];
      const granted = value === "granted";
      let desc = why;
      if (value === "denied" || value === "restricted") desc = "Turned off for Cue. Switch Cue on in System Settings.";
      if (value === "unavailable") desc = "Cue's system-audio helper is not built: install the Xcode command line tools (xcode-select --install) and restart Cue. Sessions will have no \"Them\".";
      if (kind === "screen" && !granted && status.screenAsked) desc = "Switch Cue on in System Settings, then relaunch Cue: macOS applies this permission only to a fresh start.";
      row.innerHTML = `<span class="ibox"><svg><use href="/icons.svg#i-${icon}"/></svg></span>
        <div class="text"><div class="title">${title}</div><div class="desc${granted || value === "not-determined" ? "" : " warn"}">${desc}</div></div>`;
      if (granted) {
        row.insertAdjacentHTML("beforeend", `<span class="state ok"><svg><use href="/icons.svg#i-check"/></svg>Allowed</span>`);
      } else if (value !== "unavailable") {
        const button = document.createElement("button");
        button.className = "btn primary";
        button.textContent = busy === kind ? "Waiting…" : value === "not-determined" ? "Allow" : "Open System Settings";
        button.disabled = busy === kind;
        button.onclick = async () => {
          busy = kind;
          render();
          try { status = await native.invoke("permission-request", kind); } finally { busy = null; render(); onChange(status); }
        };
        row.append(button);
        if (kind === "screen" && status.screenAsked) {
          const relaunch = document.createElement("button");
          relaunch.className = "btn";
          relaunch.textContent = "Relaunch Cue";
          relaunch.onclick = () => native.send("relaunch");
          row.append(relaunch);
        }
      }
      return row;
    }));
  };

  const refresh = async () => {
    if (busy) return;
    status = await native.invoke("permissions").catch(() => status);
    if (!status) return;
    render();
    onChange(status);
  };
  refresh();
  // A grant made in System Settings shows up here without touching Cue.
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 1500);
  return () => clearInterval(timer);
}
