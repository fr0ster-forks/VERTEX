"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../openai-compatible");
const modelConfig = require("../model-config");

test("API provider catalog matches the ABAP-AI-Code key providers", () => {
  assert.deepEqual(Object.keys(api.PROVIDERS), ["openai-api", "mistral-api", "gemini-api", "groq-api",
    "cerebras-api", "openrouter-api", "nvidia-api"]);
  for (const id of Object.keys(api.PROVIDERS)) {
    assert.ok(modelConfig.PROVIDERS.some(provider => provider.id === id && provider.setting === id));
    assert.match(api.PROVIDERS[id].base, /^https:\/\//);
  }
});

test("LLM Providers offers an independent fold control for each model list", () => {
  const panel = { webview: { onDidReceiveMessage: () => {} } };
  const vscode = { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === "provider" ? "copilot" : fallback }) } };
  modelConfig.open(vscode, async () => [], () => "", () => {}, null);
  assert.match(panel.webview.html, /Collapse models/);
  assert.match(panel.webview.html, /s\.expanded = !s\.expanded/);
  assert.match(panel.webview.html, /body\.hidden = !s\.expanded/);
  assert.match(panel.webview.html, /select-key/);
});

test("API model list uses the selected provider and labels", async () => {
  const calls = [];
  const list = await api.models("gemini-api", "secret", async (...args) => {
    calls.push(args); return { data: [{ id: "gemini-z", name: "Z" }, { id: "gemini-a", name: "A" }] };
  });
  assert.deepEqual(calls, [["gemini-api", "secret", "/models"]]);
  assert.deepEqual(list, [{ id: "gemini-a", label: "A" }, { id: "gemini-z", label: "Z" }]);
});

test("OpenAI-compatible provider executes SAP tools and accepts a final plan", async () => {
  const requests = [], toolCalls = [];
  const answers = [{ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
    id: "call-1", type: "function", function: { name: "read_sap_object", arguments: '{"object_name":"ZCL_A"}' }
  }] } }] }, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
    id: "call-2", type: "function", function: { name: "submit_vertex_answer",
      arguments: '{"answer":"Класс прочитан","navigation":null}' }
  }] } }] }];
  const result = await api.ask({ assistant: "mistral-api", apiKey: "secret", model: "mistral-test",
    instructions: "Use SAP tools", prompt: "Read class", schema: { type: "object" },
    tools: [{ name: "read_sap_object", description: "Read", inputSchema: { type: "object" } }],
    request: async (id, key, route, body) => { requests.push({ id, key, route, body }); return answers.shift(); },
    callTool: async (name, args) => { toolCalls.push([name, args]); return { source: "CLASS zcl_a." }; } });
  assert.deepEqual(result.plan, { answer: "Класс прочитан", navigation: null });
  assert.deepEqual(toolCalls, [["read_sap_object", { object_name: "ZCL_A" }]]);
  assert.equal(requests[0].route, "/chat/completions");
  assert.equal(requests[0].body.tools[0].function.name, "read_sap_object");
  assert.deepEqual(requests[1].body.messages.at(-1), {
    role: "tool", tool_call_id: "call-1", content: '{"source":"CLASS zcl_a."}'
  });
});
