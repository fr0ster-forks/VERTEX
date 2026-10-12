"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const report = require("../log-report");

test("session report reads provider logs without treating tool results as prompts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-log-report-"));
  try {
    const folder = path.join(root, "claude_compatible");
    fs.mkdirSync(folder);
    const records = [
      { timestamp: "2026-10-12T10:00:00Z", type: "user", message: { role: "user", content: "Explain this class" } },
      { timestamp: "2026-10-12T10:00:02Z", type: "assistant", message: { id: "m1", model: "mistral-test", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 }, content: [{ type: "tool_use", name: "read_sap_object", input: { object_name: "ZCL_TEST" } }] } },
      { timestamp: "2026-10-12T10:00:03Z", type: "user", message: { role: "user", content: [{ type: "tool_result", content: "object found" }] } },
      { timestamp: "2026-10-12T10:00:04Z", type: "assistant", message: { id: "m2", model: "mistral-test", usage: { input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 5 }, content: [{ type: "text", text: "It has one method." }] } },
      { timestamp: "2026-10-12T10:00:05Z", type: "assistant", message: { id: "m2", model: "mistral-test", usage: { input_tokens: 50, output_tokens: 30 }, content: [] } }
    ];
    fs.writeFileSync(path.join(folder, "mistral-api_20261012_100000.jsonl"), records.map(row => JSON.stringify(row)).join("\n") + "\n{unfinished", "utf8");
    const data = report.readSessions(root);
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].prompts.length, 1);
    assert.equal(data.sessions[0].provider, "mistral-api");
    assert.deepEqual(data.sessions[0].usage, { input: 150, output: 50, cacheRead: 10, cacheWrite: 5 });
    assert.equal(data.sessions[0].prompts[0].details.length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sidebar scroll button opens the theme-aware report from the configured log folder", async () => {
  const commands = new Map(), posted = [];
  let receive;
  const panel = { webview: { postMessage: message => posted.push(message), onDidReceiveMessage: callback => { receive = callback; }, html: "" },
    onDidDispose() {}, reveal() {} };
  const vscode = { ViewColumn: { Active: 1 }, workspace: { getConfiguration: () => ({ get: () => "" }) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; } },
    window: { createWebviewPanel: () => panel } };
  report.register(vscode, { subscriptions: [] });
  assert.match(fs.readFileSync(path.join(__dirname, "../sidebar.js"), "utf8"), /data-action="logs"[^>]*>📜<\/button>/);
  commands.get("vertex.showLogs")();
  await receive({ action: "ready" });
  assert.equal(posted[0].report.configured, false);
  assert.match(panel.webview.html, /var\(--vscode-editor-background\)/);
  assert.doesNotMatch(panel.webview.html, /\{\{NONCE\}\}/);
  new vm.Script(panel.webview.html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)[1]);
});
