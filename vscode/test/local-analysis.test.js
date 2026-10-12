"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const local = require("../local-analysis");
const navigation = require("../local-navigation");

function document(name, text) {
  const uri = { scheme: "file", fsPath: name, toString: () => "file:///" + name };
  return { uri, languageId: "abap", getText: () => text, lineCount: text.split(/\r?\n/).length,
    offsetAt: at => text.split(/\r?\n/).slice(0, at.line).join("\n").length + (at.line ? 1 : 0) + at.character };
}

const program = document("zreport.prog.abap", "REPORT zreport.\nSTART-OF-SELECTION.\nDATA(result) = NEW zcl_calc( )->run( ).\nWRITE result.");
const klass = document("zcl_calc.clas.abap", "CLASS zcl_calc DEFINITION.\n PUBLIC SECTION.\n METHODS run.\nENDCLASS.\nCLASS zcl_calc IMPLEMENTATION.\n METHOD run.\n DATA x TYPE i.\n x = 1.\n ENDMETHOD.\nENDCLASS.");
const documents = new Map([[program.uri.toString(), program], [klass.uri.toString(), klass]]);
const vscode = { workspace: { findFiles: async () => [...documents.values()].map(d => d.uri),
  openTextDocument: async uri => documents.get(uri.toString()) },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { this.start = { line: startLine, character: startCharacter }; this.end = { line: endLine, character: endCharacter }; } },
  Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } } };

test("local object identity follows abapGit filenames and current editor source", () => {
  assert.deepEqual(local.sourceObject(program), { object_name: "ZREPORT", object_type: "PROG" });
  assert.deepEqual(local.sourceObject(klass), { object_name: "ZCL_CALC", object_type: "CLAS" });
});

test("local class offers UML, metrics, logic and calls through abaplint", async () => {
  const session = local.create(vscode, klass, local.sourceObject(klass));
  const root = "/sap/bc/adt/vertex/";
  const metrics = await session.request(root + "metrics/ZCL_CALC?type=CLAS");
  assert.equal(metrics.engine, "Local source + abaplint");
  assert.ok(metrics.units.some(unit => /RUN/.test(unit.unit_name)));
  const uml = await session.request(root + "class/ZCL_CALC");
  assert.ok(uml.nodes.some(node => node.name === "ZCL_CALC"));
  const logic = await session.request(root + "flow/ZCL_CALC?type=CLAS&mode=scheme&unit=RUN");
  assert.match(logic.mermaid, /flowchart/i);
  const calls = await session.request(root + "flow/ZCL_CALC?type=CLAS&mode=calls");
  assert.match(calls.mermaid, /flowchart/i);
});

test("local UML method opens beside the diagram without taking focus", async () => {
  let options, selected;
  const host = { ...vscode, ViewColumn: { One: 1, Beside: -2 },
    Selection: class { constructor(start) { selected = start; } },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    window: { showTextDocument: async (_document, value) => { options = value; return { selection: null, revealRange() {} }; } } };
  await local.create(host, klass, local.sourceObject(klass)).openSource({ name: "ZCL_CALC", type: "CLAS", method: "RUN", beside: true, preserveFocus: true });
  assert.equal(options.viewColumn, -2);
  assert.equal(options.preserveFocus, true);
  assert.equal(selected.line, 5);
});

test("local folder analyzes its ABAP classes as one package", async () => {
  const folder = { scheme: "file", fsPath: "C:\\work", path: "C:\\work" };
  const first = document("C:\\work\\zcl_first.clas.abap", "CLASS zcl_first DEFINITION.\n PUBLIC SECTION.\n METHODS run.\nENDCLASS.\nCLASS zcl_first IMPLEMENTATION.\n METHOD run.\n ENDMETHOD.\nENDCLASS.");
  const second = document("C:\\work\\sub\\zcl_second.clas.abap", "CLASS zcl_second DEFINITION.\n PUBLIC SECTION.\n METHODS run.\nENDCLASS.\nCLASS zcl_second IMPLEMENTATION.\n METHOD run.\n ENDMETHOD.\nENDCLASS.");
  const outside = document("C:\\other\\zcl_outside.clas.abap", "CLASS zcl_outside DEFINITION. ENDCLASS.");
  const files = new Map([first, second, outside].map(item => [item.uri.toString(), item]));
  const host = { ...vscode, RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: { findFiles: async () => [...files.values()].map(item => item.uri), openTextDocument: async uri => files.get(uri.toString()) } };
  const session = await local.createPackage(host, folder);
  const uml = await session.request("/sap/bc/adt/vertex/package/WORK?type=DEVC");
  assert.deepEqual(uml.nodes.map(node => node.name).sort(), ["ZCL_FIRST", "ZCL_SECOND"]);
  const progress = [];
  const metrics = await session.request("/sap/bc/adt/vertex/metrics/WORK?type=DEVC", text => progress.push(text));
  assert.deepEqual(metrics.objects.map(item => item.object).sort(), ["ZCL_FIRST", "ZCL_SECOND"]);
  assert.ok(progress.some(text => /Reusing ZCL_FIRST \(cached\)/.test(text)), progress.join("\n"));
});

test("local package cache refreshes after an editor change", async () => {
  const folder = { scheme: "file", fsPath: "C:\\work", path: "C:\\work" };
  let text = "CLASS zcl_live DEFINITION. PUBLIC SECTION. METHODS first. ENDCLASS. CLASS zcl_live IMPLEMENTATION. METHOD first. ENDMETHOD. ENDCLASS.";
  const item = document("C:\\work\\zcl_live.clas.abap", text);
  item.version = 1; item.getText = () => text;
  const host = { ...vscode, RelativePattern: class {}, workspace: { findFiles: async () => [item.uri], openTextDocument: async () => item } };
  const session = await local.createPackage(host, folder);
  const resource = "/sap/bc/adt/vertex/package/WORK?type=DEVC";
  assert.deepEqual((await session.request(resource)).nodes[0].methods.map(method => method.name), ["FIRST"]);
  text = text.replace("METHODS first.", "METHODS first. METHODS second."); item.version++;
  assert.deepEqual((await session.request(resource)).nodes[0].methods.map(method => method.name), ["FIRST", "SECOND"]);
});

test("local source lookup prefers the active file's package folder", async () => {
  const owner = document("C:\\work\\src\\zmain.prog.abap", "REPORT zmain.");
  const ownClass = document("C:\\work\\src\\zcl_target.clas.abap", "CLASS zcl_target DEFINITION. ENDCLASS.");
  const foreignClass = document("C:\\other\\zcl_target.clas.abap", "CLASS zcl_target DEFINITION. ENDCLASS.");
  const files = new Map([foreignClass, owner, ownClass].map(item => [item.uri.toString(), item]));
  const host = { ...vscode, workspace: { findFiles: async () => [...files.values()].map(item => item.uri),
    openTextDocument: async uri => files.get(uri.toString()) } };
  const session = local.create(host, owner, local.sourceObject(owner));
  assert.equal(await session.find("ZCL_TARGET", "CLAS"), ownClass);
});

test("local source lookup rejects ambiguous names outside the active package folder", async () => {
  const owner = document("C:\\work\\src\\zmain.prog.abap", "REPORT zmain.");
  const left = document("C:\\work\\left\\zcl_target.clas.abap", "CLASS zcl_target DEFINITION. ENDCLASS.");
  const right = document("C:\\work\\right\\zcl_target.clas.abap", "CLASS zcl_target DEFINITION. ENDCLASS.");
  const files = new Map([owner, left, right].map(item => [item.uri.toString(), item]));
  const host = { ...vscode, workspace: { findFiles: async () => [...files.values()].map(item => item.uri),
    openTextDocument: async uri => files.get(uri.toString()) } };
  const session = local.create(host, owner, local.sourceObject(owner));
  await assert.rejects(session.find("ZCL_TARGET", "CLAS"), /multiple package folders/);
});

test("local package reports ambiguous object names instead of opening another package's file", async () => {
  const folder = { scheme: "file", fsPath: "C:\\work", path: "C:\\work" };
  const first = document("C:\\work\\one\\zcl_same.clas.abap", "CLASS zcl_same DEFINITION. ENDCLASS.");
  const second = document("C:\\work\\two\\zcl_same.clas.abap", "CLASS zcl_same DEFINITION. ENDCLASS.");
  const files = new Map([first, second].map(item => [item.uri.toString(), item]));
  const host = { ...vscode, workspace: { findFiles: async () => [...files.values()].map(item => item.uri),
    openTextDocument: async uri => files.get(uri.toString()) } };
  await assert.rejects(local.createPackage(host, folder), /multiple folders/);
});

test("local forward analysis reads unsaved source and links to local documents", async () => {
  const result = await local.originSources(vscode, program,
    { source: program.uri.toString(), line: 4, column: 6, variable: "RESULT" });
  assert.equal(result.sources[0].text, program.getText());
  assert.equal(result.sourceFor(program.uri.toString()), program.uri.toString());
  assert.equal((await result.openSource(result.sources[0], { line: 3 })).document, program);
});

test("local definition navigates from a program to a class and its method", async () => {
  const cls = await navigation.resolve(vscode, program, { line: 2, character: 23 });
  assert.equal(cls.target.uri.toString(), klass.uri.toString());
  assert.equal(cls.target.range.start.line, 0);
  const method = await navigation.resolve(vscode, program, { line: 2, character: 33 });
  assert.equal(method.target.uri.toString(), klass.uri.toString());
  assert.equal(method.target.range.start.line, 5);
});

test("local backward usage finds calls in workspace source without SAP", async () => {
  const callers = local.whereUsed(vscode, klass, async (document, data) => ({
    id: document.uri.toString(), text: document.getText(), objectName: data.object_name, objectType: data.object_type
  }));
  const source = { text: klass.getText(), objectName: "ZCL_CALC", objectType: "CLAS" };
  const result = await callers(source, 6, 8);
  assert.deepEqual(result.places.map(place => [place.source.objectName, place.line]), [["ZREPORT", 3]]);
});
