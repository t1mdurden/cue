#!/usr/bin/env node
// Answer-quality eval for screen and meeting questions, on the exact path the overlay drives
// (via bench.mjs's openRoom): a live session room, a screenshot upload, and a hidden message
// carrying the 10-line transcript. Ground truth comes from scripts/make-fixtures.py, so every
// check is deterministic code, not an LLM judge. A case passes only if the answer contains the
// fact the fixture generator wrote; the no-context case passes only by saying the answer is not
// there and inventing nothing. Each case runs N times and the summary prints per-case and
// per-backend pass rate with first-token time, total time, and word count.
//   node scripts/eval-context.mjs --server http://127.0.0.1:8787 --backend local-4b
//   node scripts/eval-context.mjs --trials 3 --image test/fixtures/screen-dense.png
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { contextMessage, decodePng, encodePng, openRoom, withNonce } from "./bench.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
const server = args.server || "http://127.0.0.1:8787";
const backend = args.backend || process.env.CUE_EVAL_BACKEND || "unnamed";
const trials = Number(args.trials || 2);
const base = decodePng(readFileSync(args.image || new URL("../test/fixtures/screen-dense.png", import.meta.url)));
const out = args.out || `logs/eval-context-${backend}.json`;

const all = (text, patterns) => patterns.every((p) => p.test(text));
const count = (text, patterns) => patterns.filter((p) => p.test(text)).length;
// The right reply to a question with no answer in the context: say so, and invent no contact
// detail. The deterministic check covers refusal wording plus phone/email-shaped fabrication;
// open-ended "invented nothing" would need a judge, which this harness deliberately avoids.
const saysMissing = (text) =>
  /not (?:mentioned|available|shown|show|display|displayed|provided|visible|listed|contained|contained in|in (?:the )?(?:screen|transcript|conversation|context)|on (?:the |your )?screen)|don'?t (?:know|see|have|find)|doesn'?t (?:say|show|display|mention|include)|no (?:[\w-]+ ){0,3}(?:phone|contact|number|email|information)|can'?not|can'?t (?:find|see|determine)|isn'?t (?:in|on|shown|mentioned)|unavailable/i.test(text);
const inventsContact = (text) => /\+?\d[\d\s().-]{6,}\d/.test(text) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(text);

const cases = [
  { id: "screen-total", ask: "What is the total due on the invoice on my screen?", check: (t) => all(t, [/812[.,]40/]) },
  { id: "screen-invoice-id", ask: "What is the invoice number on my screen?", check: (t) => all(t, [/CUE-?PROBE-?4471/i]) },
  { id: "screen-line-items", ask: "List the three line-item amounts on the invoice on my screen.", check: (t) => all(t, [/520[.,]00/, /201[.,]90/, /90[.,]50/]) },
  { id: "screen-code-purpose", ask: "What does the code on my screen do?", check: (t) => count(t, [/subtotal/i, /tax/i, /csv|export/i, /invoice/i, /summar|load/i]) >= 3 },
  { id: "screen-code-tax", ask: "According to the code on my screen, what tax rate is applied?", check: (t) => all(t, [/0(?:[.,]0+)?\s*%|zero|no tax|\b0[.,]0+\b(?![.,]?\d)/i]) },
  { id: "transcript-review-day", ask: "Per the conversation, when did the vendor review move to?", check: (t) => all(t, [/thursday/i]) },
  { id: "transcript-launch", ask: "Per the conversation, how much more time does Marketing want for the launch?", check: (t) => all(t, [/(?:two|2)\s*(?:more\s+)?weeks/i]) },
  { id: "meeting-recap", ask: "Give me a two-line recap of the meeting so far.", check: (t) => count(t, [/thursday/i, /(?:two|2)\s*(?:more\s+)?weeks/i, /invoice|812[.,]40|cloud bill|billing/i, /hiring/i, /marketing/i, /vendor review/i, /finance/i]) >= 3 },
  { id: "no-context-refusal", ask: "What is the vendor's support phone number?", check: (t) => saysMissing(t) && !inventsContact(t) },
  { id: "arithmetic-control", ask: "What is 17 x 3? Reply with just the number.", check: (t) => all(t, [/\b51\b/]) },
];

const words = (t) => (t.trim().match(/\S+/g) || []).length;
const p50 = (v) => { const s = v.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const rows = [];
let harnessErrors = 0;
for (const testCase of cases) {
  for (let trial = 1; trial <= trials; trial++) {
    const room = await openRoom(server);
    const messageId = randomUUID();
    const png = encodePng(withNonce(base, trial + Date.now()));
    await room.call("uploadScreenshot", { messageId, dataBase64: png.toString("base64"), contentType: "image/png" });
    const answer = await room.ask([{ id: messageId, role: "user", parts: [{ type: "text", text: contextMessage(`Using my screen and this conversation, answer for me: ${testCase.ask}`) }] }]);
    room.socket.close();
    const passed = !answer.error && testCase.check(answer.text);
    if (answer.error) harnessErrors++;
    rows.push({ backend, case: testCase.id, trial, passed, ttft_ms: answer.ttft, total_ms: answer.total, words: words(answer.error ? answer.error : answer.text), error: answer.error || null, answer: answer.text });
    console.log(`${testCase.id} ${trial}/${trials}: ${passed ? "PASS" : "FAIL"}  ttft=${answer.ttft} ms  total=${answer.total} ms  words=${rows.at(-1).words}`);
    if (!passed) console.log(`  trace: ${JSON.stringify((answer.error || answer.text).slice(0, 500))}`);
  }
}

const perCase = Object.fromEntries(cases.map((c) => [c.id, `${rows.filter((r) => r.case === c.id && r.passed).length}/${trials}`]));
const passed = rows.filter((r) => r.passed).length;
const summary = {
  backend,
  server,
  trials_per_case: trials,
  pass_rate: `${passed}/${rows.length} (${Math.round((100 * passed) / rows.length)}%)`,
  per_case: perCase,
  ttft_p50_ms: p50(rows.map((r) => r.ttft_ms)),
  total_p50_ms: p50(rows.map((r) => r.total_ms)),
  words_p50: p50(rows.map((r) => r.words)),
};
mkdirSync("logs", { recursive: true });
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary));
console.log(`full traces: ${out}`);
// A low pass rate is a measurement, not a crash; exit non-zero only when the harness itself errored.
process.exit(harnessErrors ? 1 : 0);
