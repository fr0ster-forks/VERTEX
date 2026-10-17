"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sessionLog = require("../session-log");

async function session(include) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-log-"));
  const log = sessionLog.create(root, "claude", "20260916_120000", include);
  log.user("explain Z_CALC");
  const call = sessionLog.tools(log, async (_deps, name) => name === "read_sap_object"
    ? { content: [{ type: "text", text: JSON.stringify({ object_name: "Z_CALC", object_type: "PROG", source: "REPORT z_calc. SECRET" }) }] }
    : { content: [{ type: "text", text: "Object not found." }], isError: true });
  await call({}, "read_sap_object", { object_type: "PROG", object_name: "Z_CALC" });
  await call({}, "modify_sap_object", { object_name: "Z_CALC", source: "REPORT z_calc. SECRET" });
  log.assistant({ model: "claude-sonnet-5", usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900 }, text: "The answer." });
  const raw = fs.readFileSync(path.join(root, "claude_compatible", "claude_20260916_120000.jsonl"), "utf8");
  fs.rmSync(root, { recursive: true, force: true });
  return { raw, lines: raw.trim().split("\n").map(l => JSON.parse(l)) };
}

test("no folder, no log", () => {
  assert.equal(sessionLog.create("", "claude"), null);
});

test("full VERTEX instructions and context are logged only when requested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-request-log-"));
  try {
    const quiet = sessionLog.create(root, "claude", "quiet", {});
    quiet.user("show UML");
    quiet.request({ instructions: "system secret", prompt: "context secret", tools: [], schema: {} });
    assert.doesNotMatch(fs.readFileSync(quiet.file, "utf8"), /secret/);

    const full = sessionLog.create(root, "claude", "full", { request: true });
    full.user("show UML");
    full.request({ instructions: "Use the diagram", prompt: "Current VERTEX view: Z_RIG", tools: [{ name: "read_sap_object" }], schema: { type: "object" } });
    const records = fs.readFileSync(full.file, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records[1].type, "vertex_request");
    assert.equal(records[1].request.instructions, "Use the diagram");
    assert.equal(records[1].request.prompt, "Current VERTEX view: Z_RIG");
    assert.equal(records[1].request.tools[0].name, "read_sap_object");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the minimal log is tokens only: no question, answer, tool call or code", async () => {
  const { raw, lines } = await session({});
  assert.deepEqual(lines.map(l => l.type), ["user", "assistant"]);
  assert.doesNotMatch(raw, /SECRET|explain Z_CALC|The answer|read_sap_object/);
  assert.deepEqual(lines[1].message.usage, { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 });
  assert.equal(lines[1].message.model, "claude-sonnet-5");
});

test("questions, answers and tool calls are logged by choice, and code only when it is chosen too", async () => {
  const withoutCode = await session({ questions: true, answers: true, tools: true });
  assert.doesNotMatch(withoutCode.raw, /SECRET/);
  const lines = withoutCode.lines;
  assert.deepEqual(lines.map(l => l.type), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.equal(lines[0].message.content, "explain Z_CALC");
  assert.equal(lines[1].message.content[0].type, "tool_use");
  assert.equal(lines[2].message.content[0].tool_use_id, lines[1].message.content[0].id);
  assert.match(lines[2].message.content[0].content, /"object_name":"Z_CALC"/);
  assert.match(lines[3].message.content[0].input.source, /characters, not logged/);
  assert.equal(lines[4].message.content[0].is_error, true);
  assert.equal(lines[5].message.content[0].text, "The answer.");

  const withCode = await session({ tools: true, code: true });
  assert.match(withCode.raw, /SECRET/);
  assert.doesNotMatch(withCode.raw, /explain Z_CALC|The answer/);

  const codeWithoutTools = await session({ code: true });
  assert.doesNotMatch(codeWithoutTools.raw, /SECRET/);
});

test("direct Anthropic-style assistant tools keep the result and log the call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-log-"));
  try {
    const log = sessionLog.create(root, "anthropic-api", "direct", { tools: true });
    const result = await sessionLog.assistantTool(log, "read_sap_object", { object_name: "ZCL_A" },
      async () => ({ object_name: "ZCL_A", source: "CLASS zcl_a." }));
    assert.equal(result.source, "CLASS zcl_a.");
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map(line => line.type), ["assistant", "user"]);
    assert.equal(lines[0].message.content[0].name, "read_sap_object");
    assert.equal(lines[1].message.content[0].tool_use_id, lines[0].message.content[0].id);
    assert.doesNotMatch(JSON.stringify(lines), /CLASS zcl_a/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
