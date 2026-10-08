// First-run Setup: the macOS permissions first, then where answers come from (and its model). The
// Electron main process opens this before the overlay on the first launch and whenever a permission
// is missing; "Start Cue" proves the chosen backend answers, marks setup done and closes it.
import { mountAnswers } from "/answers.js";
import { allGranted, mountPermissions } from "/permissions.js";

const native = window.ipcRenderer || null;
const $ = (id) => document.getElementById(id);
const steps = ["permissions", "answers"];
let done = false;   // an earlier Setup already chose a backend that answered

function show(step) {
  if (!steps.includes(step)) step = "permissions";
  for (const button of document.querySelectorAll("#steps button")) button.setAttribute("aria-selected", String(button.dataset.step === step));
  for (const page of document.querySelectorAll(".page")) page.classList.toggle("active", page.dataset.page === step);
  history.replaceState(null, "", `#${step}`);
}
for (const button of document.querySelectorAll("#steps button")) button.onclick = () => show(button.dataset.step);
native?.on("settings-tab", show);

const close = () => (native ? native.send("setup-done") : (location.href = "/"));

let granted = false;
mountPermissions($("permission-rows"), (status) => {
  granted = allGranted(status);
  $("to-answers").textContent = done ? "Done" : granted ? "Continue" : "Continue without them";
  $("permissions-note").textContent = granted ? "" : "Sessions stay off until all three are allowed.";
});
$("to-answers").onclick = () => (done ? close() : show("answers"));
$("back").onclick = () => show("permissions");

// Start Cue only once the chosen backend answers: its model downloaded and running, its key
// accepted, its account signed in. The answers module says what is still missing; Start then asks
// the model one tiny question, so a wrong key is found here and not in the first meeting.
const answers = mountAnswers($("answers"), {
  onReady(ready, why) {
    $("finish").disabled = !ready;
    $("answers-note").textContent = ready ? "" : why;
  },
});
$("finish").onclick = async () => {
  $("finish").disabled = true;
  $("answers-note").textContent = "Checking that it answers…";
  const result = await answers.test();
  if (!result.ok) {
    $("answers-note").textContent = result.error;
    $("finish").disabled = false;
    return;
  }
  try {
    await answers.done();
    close();
  } catch (error) {
    $("answers-note").textContent = error.message;
    $("finish").disabled = false;
  }
};

show(location.hash.slice(1) || "permissions");

// Reopened later for a missing permission: the backend was chosen in an earlier Setup.
fetch("/rpc/settings/get", { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("cue.token") || "dev-token"}`, "content-type": "application/json" }, body: '{"json":{},"meta":[]}' })
  .then((r) => r.json())
  .then(({ json }) => { if (json.setupDone && json.chosen) { done = true; $("to-answers").textContent = "Done"; } })
  .catch(() => {});
