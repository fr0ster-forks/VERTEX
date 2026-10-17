"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cache = require("../sap-cache");
const { writeProject } = require("../sap-transpile");
const { launch } = require("../local-run");

const sources = [{ name: "ZPROG", type: "PROG", include: "main", text: "REPORT zprog.\nWRITE / 'hello'.\n" },
  { name: "ZCL_A", type: "CLAS", include: "main", text: "" }, { name: "ZFG", type: "FUGR", include: "SAPLZFG", kind: "main", text: "" }];

test("a build is kept per system and object, and read back as it was", () => {
  const folder = cache.cacheFolder("SYS|100", { object_name: "zprog", object_type: "prog" });
  assert.match(folder, /vertex-sap-abap[\\/]SYS_100[\\/]PROG-ZPROG$/);
  fs.rmSync(folder, { recursive: true, force: true });
  assert.equal(cache.readKept(folder), null);
  cache.keep(folder, { sources, dictionary: [], fingerprint: "2026-10-16T10:00:00.000Z" });
  assert.equal(cache.readKept(folder).sources.length, 3);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a run of the same build takes its transpiled code again; a new build transpiles", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-sap-cache-"));
  try {
    const file = writeProject("TEST", [sources[0]], [], folder);
    fs.writeFileSync(path.join(folder, "vertex-fingerprint.json"), JSON.stringify({ fingerprint: "one", shown: file }));
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8") };
    const runOnce = async () => {
      let log = "";
      const vscode = { workspace: { getWorkspaceFolder: () => undefined },
        window: { createOutputChannel: () => ({ append: t => { log += t; }, appendLine: t => { log += t + "\n"; }, hide() {}, show() {} }) } };
      const result = await launch(vscode, false, { document, selection: {}, trace: true });
      return { log, result };
    };
    const first = await runOnce();
    assert.match(first.log, /^Transpiling /m);
    const second = await runOnce();
    assert.match(second.log, /Unchanged since the last run, transpiled code taken again/);
    assert.doesNotMatch(second.log, /Transpiler CLI/);
    assert.match(second.result.output, /hello/);
    assert.equal(second.result.records.length, first.result.records.length, "recorded as before, not instrumented twice");
    fs.writeFileSync(path.join(folder, "vertex-fingerprint.json"), JSON.stringify({ fingerprint: "two", shown: file }));
    assert.match((await runOnce()).log, /Transpiler CLI/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("a local file's build is taken again until a source of its folder changes", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-local-stamp-"));
  try {
    const file = path.join(folder, "zstamp.prog.abap");
    fs.writeFileSync(file, "REPORT zstamp.\nWRITE / 'one'.\n");
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8"), isDirty: false };
    const runOnce = async () => {
      let log = "";
      const vscode = { workspace: { getWorkspaceFolder: () => ({ uri: { fsPath: folder } }) },
        window: { createOutputChannel: () => ({ append: t => { log += t; }, appendLine: t => { log += t + "\n"; }, hide() {}, show() {} }) } };
      const result = await launch(vscode, false, { document, selection: {}, trace: true });
      return { reused: /taken again/.test(log), output: result.output };
    };
    assert.equal((await runOnce()).reused, false);
    assert.equal((await runOnce()).reused, true);
    fs.writeFileSync(file, "REPORT zstamp.\nWRITE / 'two'.\n");
    const changed = await runOnce();
    assert.deepEqual([changed.reused, /two/.test(changed.output)], [false, true]);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
