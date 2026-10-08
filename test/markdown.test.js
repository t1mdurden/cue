import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../public/markdown.js";

test("fenced code becomes a pre/code block, not raw backticks", () => {
  const html = renderMarkdown("Here:\n\n```python\nprint('hi')\n```");
  assert.match(html, /<pre><code data-lang="python">/);
  assert.ok(!html.includes("```"), "backticks should be consumed");
  assert.match(html, /print\(&#39;hi&#39;\)/);
});

test("inline code, bold, lists render", () => {
  const html = renderMarkdown("Use `npm` and **care**\n\n- one\n- two");
  assert.match(html, /<code>npm<\/code>/);
  assert.match(html, /<strong>care<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("hostile screen text cannot inject markup", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)> and <script>evil()</script>");
  assert.ok(!html.includes("<img"), "img tag must be escaped");
  assert.ok(!html.includes("<script>"), "script tag must be escaped");
  assert.match(html, /&lt;script&gt;/);
});
