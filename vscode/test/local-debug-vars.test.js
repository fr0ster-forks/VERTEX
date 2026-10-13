"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readVariables, pollVariables, declarationLine, removeDeclarationBreakpoints, register } = require("../local-debug-vars");

test("local stop reads the current frame and unwraps ABAP scalar values", async () => {
  const calls = [];
  const session = { async customRequest(command, args) {
    calls.push([command, args]);
    if (command === "stackTrace") return { stackFrames: [{ id: 7, name: "START-OF-SELECTION" }] };
    if (command === "scopes") return { scopes: [{ name: "Local", variablesReference: 11 }] };
    if (command === "variables") return { variables: [{ name: "p_clean", value: "Character", variablesReference: 12 }] };
    if (command === "evaluate") return { result: "'X'" };
    throw new Error(command);
  } };
  const state = await readVariables(session, 2);
  assert.equal(state.frame, "START-OF-SELECTION");
  assert.deepEqual(state.variables, [{ scope: "Local", name: "p_clean", value: "'X'" }]);
  assert.equal(state.line, 0);
  assert.deepEqual(calls.map(call => call[0]), ["stackTrace", "scopes", "variables", "evaluate"]);
});

test("local history excludes generated JavaScript temporaries before evaluating values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-abap-vars-"));
  const source = path.join(root, "ztest.prog.abap");
  fs.writeFileSync(source, "REPORT ztest.\nDATA a TYPE i.\nDATA b TYPE i.\n");
  try {
    const evaluated = [];
    const session = { async customRequest(command, args) {
      if (command === "stackTrace") return { stackFrames: [{ id: 7, name: "START-OF-SELECTION", source: { path: source }, line: 12 }] };
      if (command === "scopes") return { scopes: [{ name: "Local", variablesReference: 11 }] };
      if (command === "variables") return { variables: ["a", "b", "unique2", "indexBackup1", "this"]
        .map(name => ({ name, value: "Integer", variablesReference: 12 })) };
      if (command === "evaluate") { evaluated.push(args.expression); return { result: "5" }; }
      throw new Error(command);
    } };
    const state = await readVariables(session, 2);
    assert.deepEqual(state.variables.map(variable => variable.name), ["a", "b"]);
    assert.deepEqual(evaluated, ["a.get()", "b.get()"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local declaration breakpoints are removed but executable breakpoints remain", async () => {
  assert.equal(declarationLine("data a type i."), true);
  assert.equal(declarationLine("a = 5."), false);
  const make = line => ({ location: { uri: { scheme: "file", fsPath: "C:/src/test.prog.abap" }, range: { start: { line } } } });
  const declaration = make(0), assignment = make(1);
  let removed;
  const vscode = { workspace: { async openTextDocument() {
    return { lineCount: 2, lineAt: line => ({ text: ["data a type i.", "a = 5."][line] }) };
  } }, debug: { removeBreakpoints: items => { removed = items; } } };
  assert.equal(await removeDeclarationBreakpoints(vscode, [declaration, assignment]), 1);
  assert.deepEqual(removed, [declaration]);
});

test("local variable tracker covers the active debug adapter type", () => {
  const types = [];
  const vscode = { debug: { breakpoints: [], registerDebugAdapterTrackerFactory(type) {
    types.push(type); return { dispose() {} };
  }, onDidChangeBreakpoints() { return { dispose() {} }; } } };
  const context = { subscriptions: [] };
  register(vscode, context, () => {});
  assert.deepEqual(types, ["*"]);
  context.subscriptions.forEach(subscription => subscription.dispose());
});

test("polling reads variables from the active stopped thread", async () => {
  const commands = [];
  const session = { async customRequest(command) {
    commands.push(command);
    if (command === "threads") return { threads: [{ id: 4 }] };
    if (command === "stackTrace") return { stackFrames: [{ id: 8, name: "START-OF-SELECTION" }] };
    if (command === "scopes") return { scopes: [{ name: "Script", variablesReference: 11 }] };
    if (command === "variables") return { variables: [{ name: "a", value: "Integer", variablesReference: 0 }] };
  } };
  assert.deepEqual(await pollVariables(session), { frame: "START-OF-SELECTION", source: "", line: 0,
    variables: [{ scope: "Script", name: "a", value: "Integer" }] });
  assert.deepEqual(commands, ["threads", "stackTrace", "scopes", "variables"]);
});
