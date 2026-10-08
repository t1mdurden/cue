// "Where answers come from": the backend cards and what each needs (a local model and its download,
// a Claude sign-in, an API key, an endpoint). Setup's first step and Settings → Model both mount it.
const native = window.ipcRenderer || null;
const token = localStorage.getItem("cue.token") || "dev-token";

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

const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const gb = (value) => `${Number(value).toFixed(value < 10 ? 1 : 0)} GB`;

const BACKENDS = [
  { id: "local", icon: "laptop", title: "On this Mac", tag: "Private", desc: "A vision model runs locally with llama.cpp. Nothing leaves the Mac." },
  { id: "claude", icon: "sparkles", title: "Claude subscription", tag: "Cloud", desc: "Through the Claude Code CLI you are signed in to (Pro or Max plan). No API key." },
  { id: "anthropic", icon: "key", title: "Anthropic API", tag: "Cloud", desc: "Claude with your own API key, billed per use." },
  { id: "openai", icon: "key", title: "OpenAI API", tag: "Cloud", desc: "GPT models with your own API key, billed per use." },
  { id: "compatible", icon: "globe", title: "Other endpoint", tag: "Cloud or local", desc: "OpenRouter, Gemini, Ollama, LM Studio or any OpenAI-compatible URL." },
];

export function mountAnswers(container, { onReady = () => {}, onChange = () => {} } = {}) {
  let settings = null;
  let catalogue = null;
  let status = null;     // models/status: download + servers
  let claude = null;     // sign-in state for the claude backend
  let repo = null;       // a Hugging Face listing the person asked for
  let message = "";      // the last test result or error
  let pollTimer = null;
  let loginStartedAt = 0;

  const save = async (patch) => {
    settings = await rpc("settings/update", patch);
    await native?.invoke("settings-changed", settings).catch(() => {});
    onChange(settings);
    return settings;
  };

  // ---- readiness: what still stands between this choice and a working answer ------------------
  function readiness() {
    const servers = status?.servers || {};
    const downloading = status?.download?.state === "downloading";
    if (downloading) return [false, "Downloading…"];
    if (settings.asrBackend === "local" && catalogue && !catalogue.whisper.present) return [false, "Download the speech model first."];
    if (settings.asrBackend === "openai" && !settings.keys.openai.set) return [false, "OpenAI transcription needs an OpenAI API key."];
    switch (settings.llmBackend) {
      case "local": {
        const llama = servers.llama || {};
        if (llama.state === "up" || llama.state === "external") return [true, ""];
        if (llama.state === "needs-model") return [false, "Download the model first."];
        if (llama.state === "not-installed" || llama.state === "exited") return [false, llama.detail];
        return [false, "Starting the model…"];
      }
      case "claude":
        return claude?.state === "signed-in" ? [true, ""] : [false, "Sign in to Claude first."];
      case "anthropic": return settings.keys.anthropic.set ? [true, ""] : [false, "Add your Anthropic API key."];
      case "openai": return settings.keys.openai.set ? [true, ""] : [false, "Add your OpenAI API key."];
      case "compatible": return settings.compatibleBaseUrl && settings.compatibleModel ? [true, ""] : [false, "Set the endpoint's URL and model."];
    }
    return [false, ""];
  }

  // ---- render ---------------------------------------------------------------------------------
  function render() {
    const cards = h(`<div class="cards" role="radiogroup"></div>`);
    for (const backend of BACKENDS) {
      const card = h(`<button class="card" role="radio" data-backend="${backend.id}">
        <span class="radio"></span>
        <span class="text"><div class="title">${backend.title}</div><div class="desc">${backend.desc}</div></span>
        <span class="tag">${backend.tag}</span></button>`);
      card.setAttribute("aria-checked", String(settings.chosen && settings.llmBackend === backend.id));
      if (!settings.chosen && backend.id === "local") card.querySelector(".tag").textContent = "Private · suggested";
      card.onclick = async () => {
        if (settings.chosen && settings.llmBackend === backend.id) return;
        message = "";
        await save({ llmBackend: backend.id });
        refresh();
      };
      cards.append(card);
    }
    const detail = h(`<div class="detail"></div>`);
    if (!settings.chosen) {
      detail.append(h(`<p class="sub">Pick one above. Nothing is downloaded or started until you do.</p>`));
      container.replaceChildren(cards, detail);
      onReady(false, "Pick where answers come from.");
      return;
    }
    detail.append(...{ local: localDetail, claude: claudeDetail, anthropic: anthropicDetail, openai: openaiDetail, compatible: compatibleDetail }[settings.llmBackend]());
    detail.append(speechRow());
    if (settings.llmBackend !== "local" && settings.asrBackend === "local" && catalogue && !catalogue.whisper.present) detail.append(downloadRow());
    detail.append(testRow());
    container.replaceChildren(cards, detail);
    const [ready, why] = readiness();
    onReady(ready, why);
  }

  // On this Mac: the catalogue, another model from Hugging Face or a file, and the download.
  function localDetail() {
    const rows = [];
    if (!catalogue) return [h(`<p class="sub">Loading models…</p>`)];
    const current = settings.localModel ?? null;
    const isCurrent = (id) => (current ?? "qwen3-vl-4b") === id;
    rows.push(h(`<p class="sub">Models that see your screen, measured on Cue's own screen-and-meeting questions. This Mac has ${catalogue.ramGb} GB of memory.</p>`));
    for (const entry of catalogue.entries) {
      const tags = [entry.id === catalogue.recommended ? `<span class="tag good">Recommended for this Mac</span>` : "", entry.present ? `<span class="tag">Downloaded</span>` : ""].join("");
      const row = h(`<button class="opt" role="radio" data-model="${entry.id}">
        <span class="radio"></span>
        <span class="text"><div class="title">${esc(entry.label)} ${tags}</div>
        <div class="desc">${gb(entry.sizeGb)} download · needs ${entry.minRamGb} GB memory · ${esc(entry.quality)}</div></span></button>`);
      row.setAttribute("aria-checked", String(isCurrent(entry.id)));
      if (catalogue.ramGb < entry.minRamGb) row.classList.add("dim");
      row.onclick = async () => { message = ""; await save({ localModel: entry.id }); refresh(); };
      rows.push(row);
    }
    const custom = current && typeof current === "object";
    const other = h(`<details class="other"${custom || repo ? " open" : ""}><summary>Another model${custom ? `: <b>${esc(catalogue.currentLabel)}</b>` : ""}</summary>
      <p class="sub">Any GGUF vision model from Hugging Face (look for repos ending in -GGUF with an mmproj file), or files already on this Mac.</p>
      <div class="field"><input class="input" id="hf-repo" placeholder="owner/name, e.g. unsloth/Qwen3.5-4B-GGUF" value="${esc(repo?.repo || current?.repo || "")}"><button class="btn" id="hf-find">Find</button></div>
      <div id="hf-result"></div>
      <div class="field"><input class="input" id="gguf-path" placeholder="/path/to/model.gguf" value="${esc(current?.path || "")}"><input class="input" id="gguf-mmproj" placeholder="/path/to/mmproj.gguf (to see the screen)" value="${esc(current?.mmproj && current?.path ? current.mmproj : "")}"><button class="btn" id="gguf-use">Use files</button></div>
    </details>`);
    other.querySelector("#hf-find").onclick = async () => {
      repo = await rpc("models/repo", { repo: other.querySelector("#hf-repo").value });
      message = repo.ok ? "" : repo.error;
      if (!repo.ok) repo = null;
      render();
    };
    other.querySelector("#gguf-use").onclick = async () => {
      const path = other.querySelector("#gguf-path").value.trim();
      const mmproj = other.querySelector("#gguf-mmproj").value.trim();
      try { await save({ localModel: { path, ...(mmproj ? { mmproj } : {}) } }); message = ""; } catch (error) { message = error.message; }
      refresh();
    };
    if (repo) {
      const weights = repo.weights.map((w) => `<option value="${esc(w.file)}" data-size="${w.sizeGb}">${esc(w.file)} · ${gb(w.sizeGb)}</option>`).join("");
      const projectors = repo.projectors.map((w) => `<option value="${esc(w.file)}" data-size="${w.sizeGb}">${esc(w.file)} · ${gb(w.sizeGb)}</option>`).join("");
      const pick = h(`<div class="field">
        <select id="hf-file">${weights}</select>
        <select id="hf-mmproj">${projectors}<option value="">No projector (cannot see the screen)</option></select>
        <button class="btn" id="hf-use">Use this model</button></div>`);
      const preferred = repo.weights.find((w) => /Q4_K_M/i.test(w.file)) || repo.weights[0];
      pick.querySelector("#hf-file").value = preferred.file;
      pick.querySelector("#hf-use").onclick = async () => {
        const file = pick.querySelector("#hf-file").selectedOptions[0];
        const mmproj = pick.querySelector("#hf-mmproj").selectedOptions[0];
        await save({ localModel: { repo: repo.repo, file: file.value, ...(mmproj?.value ? { mmproj: mmproj.value } : {}), label: `${repo.repo.split("/").pop()} · ${file.value.replace(/\.gguf$/i, "")}`, sizes: { model: Number(file.dataset.size), mmproj: Number(mmproj?.dataset.size || 0) } } });
        repo = null;
        refresh();
      };
      other.querySelector("#hf-result").append(pick, ...(repo.projectors.length ? [] : [h(`<p class="desc warn">This repo has no vision projector (mmproj): the model would answer without seeing your screen.</p>`)]));
    }
    rows.push(other, downloadRow());
    return rows;
  }

  function downloadRow() {
    const download = status?.download || { state: "idle" };
    const llama = status?.servers?.llama || {};
    const row = h(`<div class="row dl"><span class="ibox"><svg><use href="/icons.svg#i-download"/></svg></span><div class="text"></div></div>`);
    const text = row.querySelector(".text");
    if (download.state === "downloading") {
      const pct = download.total ? Math.floor((100 * download.done) / download.total) : 0;
      text.innerHTML = `<div class="title">Downloading ${esc(download.label)}</div><div class="desc">${gb(download.done / 1e9)} of ${download.total ? gb(download.total / 1e9) : "…"}</div><div class="meter"><span style="width:${pct}%"></span></div>`;
      const cancel = h(`<button class="btn">Cancel</button>`);
      cancel.onclick = async () => { await rpc("models/cancel"); refresh(); };
      row.append(cancel);
      return row;
    }
    const needsSpeech = settings.asrBackend === "local" && !catalogue.whisper.present;
    const needs = (settings.llmBackend === "local" && llama.state === "needs-model") || needsSpeech;
    const describe = settings.llmBackend !== "local"
      ? ["Speech model not downloaded yet", `whisper large-v3-turbo (${gb(catalogue.whisper.sizeGb)}) transcribes on this Mac; it is downloaded once from Hugging Face.`]
      : {
      up: ["Ready", `${esc(llama.detail)} is running.`],
      external: ["Ready", esc(llama.detail)],
      starting: ["Starting", esc(llama.detail)],
      "not-installed": ["llama.cpp is missing", `${esc(llama.detail)}`],
      exited: ["The model stopped", esc(llama.detail)],
      "needs-model": ["Not downloaded yet", `${esc(catalogue.currentLabel)}${settings.asrBackend === "local" && !catalogue.whisper.present ? ` and the speech model (${gb(catalogue.whisper.sizeGb)})` : ""} will be downloaded from Hugging Face.`],
      off: ["", ""],
    }[llama.state] || ["", ""];
    if (settings.llmBackend === "local" && llama.state !== "needs-model" && needsSpeech) describe[0] = `${describe[0]} · speech model not downloaded (${gb(catalogue.whisper.sizeGb)})`;
    const failed = download.state === "error" ? `<div class="desc warn">${esc(download.error)}</div>` : "";
    text.innerHTML = `<div class="title">${describe[0]}</div><div class="desc">${describe[1]}</div>${failed}`;
    if (needs) {
      const button = h(`<button class="btn primary">Download</button>`);
      button.onclick = async () => { await rpc("models/download", {}); refresh(); };
      row.append(button);
    }
    return row;
  }

  // Claude subscription: model, effort and the CLI's sign-in.
  function claudeDetail() {
    const signIn = claude ? {
      "signed-in": `Signed in${claude.email ? ` as ${esc(claude.email)}` : ""}${claude.plan ? ` · ${esc(claude.plan)} plan` : ""}.`,
      "signed-out": "Not signed in — answers will fail until you sign in.",
      missing: "The claude CLI is not installed. Install Claude Code (claude.com/claude-code), then sign in.",
      outdated: `The claude CLI Cue finds first is too old (${esc(claude.detail)}). Update it.`,
    }[claude.state] || `Could not check sign-in: ${esc(claude.detail)}` : "Checking sign-in…";
    // The CLI gives a sign-in 10 minutes (src/claude-backend.js); the page waits as long, unless the
    // login already exited with an error.
    const failed = loginStartedAt && claude?.loginError;
    const waiting = loginStartedAt && !failed && claude?.state !== "signed-in" && Date.now() - loginStartedAt < 600_000;
    const text = failed ? `Sign-in failed: ${esc(claude.loginError)}` : waiting ? "Finish signing in in your browser…" : signIn;
    const account = h(`<div class="row"><span class="ibox"><svg><use href="/icons.svg#i-shield"/></svg></span>
      <div class="text"><div class="title">Claude account</div><div class="desc${claude?.state === "signed-in" ? "" : " warn"}" id="claude-auth">${text}</div></div></div>`);
    if (claude?.state === "signed-out" && !waiting && !failed) {
      const button = h(`<button class="btn primary" id="claude-login">Sign in</button>`);
      button.onclick = async () => { await rpc("settings/claudeLogin"); loginStartedAt = Date.now(); refresh(); };
      account.append(button);
    }
    return [claudeModelRow(), account];
  }

  function claudeModelRow() {
    const row = h(`<div class="row"><span class="ibox"><svg><use href="/icons.svg#i-sparkles"/></svg></span>
      <div class="text"><div class="title">Claude model</div><div class="desc" id="claude-model-desc">${esc(settings.claudeModels.find((m) => m.id === settings.claudeModel)?.desc || settings.claudeModel)}</div></div>
      <select id="claude-model">${settings.claudeModels.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("")}</select>
      <select id="claude-effort">${settings.claudeEfforts.map((e) => `<option value="${e}">${e[0].toUpperCase()}${e.slice(1)} effort</option>`).join("")}</select></div>`);
    row.querySelector("#claude-model").value = settings.claudeModel;
    row.querySelector("#claude-effort").value = settings.claudeEffort;
    row.querySelector("#claude-model").onchange = async (event) => { await save({ claudeModel: event.target.value }); render(); };
    row.querySelector("#claude-effort").onchange = async (event) => { await save({ claudeEffort: event.target.value }); render(); };
    return row;
  }

  // An API key field: shows only whether a key is set and its last characters, never the key.
  function keyRow(name, label, placeholder) {
    const key = settings.keys[name];
    const where = key.set ? (key.source === "environment" ? "from the environment" : settings.keysRemembered ? "saved, encrypted on this Mac" : "for this run only") : "";
    const row = h(`<div class="row"><span class="ibox"><svg><use href="/icons.svg#i-key"/></svg></span>
      <div class="text"><div class="title">${label}</div><div class="desc">${key.set ? `Set ${esc(key.hint)} · ${where}` : "Not set"}</div>
      <div class="field"><input class="input" type="password" autocomplete="off" spellcheck="false" placeholder="${placeholder}"><button class="btn">${key.set ? "Replace" : "Save key"}</button>${key.set && key.source === "saved" ? `<button class="link">Forget</button>` : ""}</div></div></div>`);
    const input = row.querySelector("input");
    row.querySelector(".btn").onclick = async () => {
      if (!input.value.trim()) return;
      await save({ apiKeys: { [name]: input.value.trim() } });
      input.value = "";
      await test();
    };
    const forget = row.querySelector(".link");
    if (forget) forget.onclick = async () => { await save({ apiKeys: { [name]: null } }); message = ""; render(); };
    return row;
  }

  function anthropicDetail() {
    return [keyRow("anthropic", "Anthropic API key", "sk-ant-…"), claudeModelRow()];
  }

  function openaiDetail() {
    return [keyRow("openai", "OpenAI API key", "sk-…"), endpointModelRow("openai", "openaiModel")];
  }

  function compatibleDetail() {
    const presets = settings.endpointPresets;
    const row = h(`<div class="row"><span class="ibox"><svg><use href="/icons.svg#i-globe"/></svg></span>
      <div class="text"><div class="title">Endpoint</div><div class="desc">The base URL of an OpenAI-compatible API (it ends in /v1 for most).</div>
      <div class="field"><select id="preset"><option value="">Custom URL</option>${presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("")}</select>
      <input class="input" id="base-url" placeholder="https://…/v1" value="${esc(settings.compatibleBaseUrl)}"><button class="btn" id="base-save">Save</button></div></div></div>`);
    const match = presets.find((p) => p.baseUrl === settings.compatibleBaseUrl);
    row.querySelector("#preset").value = match?.id || "";
    row.querySelector("#preset").onchange = (event) => {
      const preset = presets.find((p) => p.id === event.target.value);
      if (preset) row.querySelector("#base-url").value = preset.baseUrl;
    };
    row.querySelector("#base-save").onclick = async () => {
      try { await save({ compatibleBaseUrl: row.querySelector("#base-url").value.trim() }); message = ""; } catch (error) { message = error.message; }
      render();
    };
    return [row, keyRow("compatible", "API key (if the endpoint needs one)", "key"), endpointModelRow("compatible", "compatibleModel")];
  }

  // The model on an OpenAI-wire endpoint: typed, or picked from the endpoint's own list.
  function endpointModelRow(backend, field) {
    const row = h(`<div class="row"><span class="ibox"><svg><use href="/icons.svg#i-cpu"/></svg></span>
      <div class="text"><div class="title">Model</div><div class="desc">Pick one that accepts images, or answers will not see your screen.</div>
      <div class="field"><input class="input" id="model-id" list="model-list" placeholder="model id" value="${esc(settings[field])}"><datalist id="model-list"></datalist>
      <button class="btn" id="model-load">List models</button><button class="btn" id="model-save">Save</button></div></div></div>`);
    row.querySelector("#model-load").onclick = async () => {
      const list = await rpc("settings/endpointModels", { backend, baseUrl: settings.compatibleBaseUrl });
      message = list.ok ? `${list.models.length} models listed; start typing to pick one.` : list.error;
      row.querySelector("#model-list").replaceChildren(...list.models.map((id) => Object.assign(document.createElement("option"), { value: id })));
      container.querySelector(".test-row .desc").textContent = message;
    };
    row.querySelector("#model-save").onclick = async () => { await save({ [field]: row.querySelector("#model-id").value.trim() }); message = ""; render(); };
    return row;
  }

  function speechRow() {
    const row = h(`<div class="row"><span class="ibox"><svg><use href="/icons.svg#i-wave"/></svg></span>
      <div class="text"><div class="title">Transcription</div><div class="desc">${settings.asrBackend === "local"
        ? `whisper.cpp on this Mac${catalogue && !catalogue.whisper.present ? ` · speech model not downloaded (${gb(catalogue.whisper.sizeGb)})` : ""}. Audio never leaves the Mac.`
        : `OpenAI, with your OpenAI API key${settings.keys.openai.set ? "" : " (not set yet: add it under OpenAI API)"}. Your audio goes to OpenAI.`}</div></div>
      <select id="asr-backend"><option value="local">This Mac</option><option value="openai">OpenAI</option></select></div>`);
    row.querySelector("#asr-backend").value = settings.asrBackend;
    row.querySelector("#asr-backend").onchange = async (event) => { await save({ asrBackend: event.target.value }); refresh(); };
    return row;
  }

  function testRow() {
    const row = h(`<div class="row test-row"><span class="ibox"><svg><use href="/icons.svg#i-gauge"/></svg></span>
      <div class="text"><div class="title">Check</div><div class="desc">${esc(message || "Ask the chosen model one tiny question.")}</div></div>
      <button class="btn" id="answers-test">Test</button></div>`);
    row.querySelector("#answers-test").onclick = () => test();
    return row;
  }

  // ---- the one question that proves it ---------------------------------------------------------
  async function test() {
    message = "Asking…";
    render();
    const result = await rpc("settings/test").catch((error) => ({ ok: false, error: error.message }));
    message = result.ok ? `Answered in ${(result.firstTokenMs / 1000).toFixed(1)} s: "${result.text}"` : result.error;
    render();
    return result;
  }

  // ---- data ------------------------------------------------------------------------------------
  async function refresh() {
    clearTimeout(pollTimer);
    [settings, catalogue, status] = await Promise.all([rpc("settings/get"), rpc("models/catalogue"), rpc("models/status")]);
    if (settings.llmBackend === "claude") claude = (await rpc("settings/status", { fresh: Boolean(loginStartedAt) }).catch(() => ({}))).claude || claude;
    render();
    // Poll while something is moving: a download, a model loading, a sign-in in the browser.
    const moving = status.download.state === "downloading" || status.servers.whisper.state === "starting"
      || (settings.llmBackend === "local" && ["starting", "off"].includes(status.servers.llama.state))
      || (settings.llmBackend === "claude" && loginStartedAt && claude?.state !== "signed-in" && !claude?.loginError);
    if (moving) pollTimer = setTimeout(refresh, 1000);
    else if (loginStartedAt && claude?.state === "signed-in") loginStartedAt = 0;
  }
  native?.on("settings-changed", () => refresh());
  refresh();

  return { test, done: () => save({ setupDone: true }) };
}
