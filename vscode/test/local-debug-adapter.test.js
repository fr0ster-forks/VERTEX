"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../local-debug-adapter");

test("local debug adapter supplies the Visual Debug picture and variables", async () => {
  const commands = [], published = [];
  const vscode = { debug: { breakpoints: [] }, commands: { async executeCommand(command) { commands.push(command); } } };
  const document = { uri: { fsPath: "C:/work/src/ztest.prog.abap" } };
  const adapter = create(vscode, document, async () => {}, picture => published.push(picture));
  adapter.update({ frame: "START-OF-SELECTION", source: document.uri.fsPath, line: 12,
    variables: [{ name: "a", value: "0", scope: "Script" }] });
  assert.equal(adapter.picture().stopped.at, "ZTEST:12");
  assert.equal(adapter.picture().stopped.frames[0].url, document.uri.fsPath);
  assert.deepEqual(await adapter.command("scopes"), { groups: [{ id: "vertex-local-variables", name: "Locals" }], sy: null });
  assert.deepEqual((await adapter.command("children", { id: "vertex-local-variables" })).children[0].value, "0");
  await adapter.command("step", { kind: "into" });
  assert.deepEqual(commands, ["workbench.action.debug.stepInto"]);
  assert.equal(published.length, 1);
});

test("a waited local step returns its stopped frame and variables together", async () => {
  const vscode = { debug: { breakpoints: [] }, commands: { async executeCommand() {} } };
  const document = { uri: { fsPath: "C:/work/src/ztest.prog.abap" } };
  const adapter = create(vscode, document, async () => {}, () => {});
  const step = adapter.command("step", { kind: "into", wait: true });
  adapter.update({ frame: "START-OF-SELECTION", source: document.uri.fsPath, line: 14, stopEvent: true,
    variables: [{ name: "a", value: "5" }] });
  const stopped = await step;
  assert.equal(stopped.picture.stopped.frames[0].line, 14);
  assert.equal(stopped.groups[0].children[0].value, "5");
});

test("a waited step ignores an old polled frame until a new stop event", async () => {
  const vscode = { debug: { breakpoints: [] }, commands: { async executeCommand() {} } };
  const document = { uri: { fsPath: "C:/work/src/ztest.prog.abap" } };
  const adapter = create(vscode, document, async () => {}, () => {});
  adapter.update({ frame: "START-OF-SELECTION", source: document.uri.fsPath, line: 12, variables: [] });
  let resolved = false;
  const step = adapter.command("step", { kind: "into", wait: true }).then(value => { resolved = true; return value; });
  adapter.update({ frame: "START-OF-SELECTION", source: document.uri.fsPath, line: 12, variables: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  adapter.update({ frame: "START-OF-SELECTION", source: document.uri.fsPath, line: 14,
    variables: [], stopEvent: true });
  assert.equal((await step).picture.stopped.frames[0].line, 14);
});

test("local structure fields can be expanded and selected separately", async () => {
  const vscode = { debug: { breakpoints: [] }, commands: { async executeCommand() {} } };
  const document = { uri: { fsPath: "C:/work/src/ztest.prog.abap" } };
  const adapter = create(vscode, document, async () => {}, () => {});
  adapter.update({ frame: "START-OF-SELECTION", source: document.uri.fsPath, line: 12,
    variables: [{ name: "ls_result", value: { amount: 42, currency: "EUR" } }] });
  const roots = (await adapter.command("children", { id: "vertex-local-variables" })).children;
  assert.equal(roots[0].meta, "structure");
  assert.deepEqual((await adapter.command("children", { id: "ls_result" })).children.map(item => item.name),
    ["amount", "currency"]);
});
