"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const helpers = html => ["function poolName(program){", "function recordedUnitKey(owner,unit){"].map(start =>
  html.slice(html.indexOf(start), html.indexOf("\n", html.indexOf(start)))).join("\n") + "\n";

test("recorded structures expand and table rows are paged", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "pages", "visual-debug.html"), "latin1");
  const start = html.indexOf("var recordedOpen={},recordedPages={};");
  const end = html.indexOf("function drawRecordedVars(i){", start);
  assert.ok(start >= 0 && end > start);
  const rows = [];
  const document = {
    createElement(tag) {
      return { tag, children: [], style: {}, appendChild(child) { this.children.push(child); },
        set textContent(value) { this.text = value; }, get textContent() { return this.text; } };
    },
    createTextNode(text) { return { text }; }
  };
  const context = { document, replayAt: 0, drawRecordedVars() {} };
  vm.runInNewContext(helpers(html) + html.slice(start, end), context);
  const table = { appendChild(row) { rows.push(row); } };
  const structure = { amount: 9, currency: "EUR" };
  context.drawRecordedTree(table, "result", structure, 0, "result");
  assert.equal(rows.length, 1);
  rows[0].children[0].children[0].onclick();
  context.drawRecordedTree(table, "result", structure, 0, "result");
  assert.equal(rows.length, 4);
  const tableValue = Array.from({ length: 1000 }, (_, i) => ({ amount: i }));
  context.recordedOpen.lines = true;
  context.drawRecordedTree(table, "lines", tableValue, 0, "lines");
  assert.equal(rows.length, 106);
  assert.match(rows.at(-1).children[0].textContent, /900 remaining/);
  rows.at(-1).children[0].onclick();
  assert.equal(context.recordedPages.lines, 2);
});

test("class diagram includes callers from the recorded ABAP stack", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "pages", "visual-debug.html"), "latin1");
  const start = html.indexOf("function callGraph(byOwner){");
  const end = html.indexOf("/* Where the chosen value changed", start);
  assert.ok(start >= 0 && end > start);
  const timeline = [{ cur: { owner: "ZCL_PRICE_ROAD", name: "CALCULATE_BASE" },
    at: { url: "road.abap", line: 20 }, stack: [
      { program: "ZCL_PRICE_ROAD", unit: "CALCULATE_BASE", line: 20 },
      { program: "ZCL_CALC_FACADE", unit: "RUN", line: 31 },
      { program: "ZVERTEX_DEBUG_LAB", unit: "ZVERTEX_DEBUG_LAB", line: 19 }
    ] }];
  const context = { flow: { timeline } };
  vm.runInNewContext(helpers(html) + html.slice(start, end), context);
  const graph = context.callGraph(true);
  assert.deepEqual(Array.from(graph.order), ["ZVERTEX_DEBUG_LAB", "ZCL_CALC_FACADE", "ZCL_PRICE_ROAD"]);
  assert.ok(graph.edges["ZVERTEX_DEBUG_LAB>ZCL_CALC_FACADE"]);
  assert.ok(graph.edges["ZCL_CALC_FACADE>ZCL_PRICE_ROAD"]);
});

test("statement diagram connects nested routines of the same class", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "pages", "visual-debug.html"), "latin1");
  const start = html.indexOf("function stepFlow(){");
  const end = html.indexOf("/* The running block, green", start);
  assert.ok(start >= 0 && end > start);
  const frame = (program, unit, line) => ({ program, unit, include: program, line, url: program + ".abap" });
  const root = frame("ZREPORT", "ZREPORT", 5);
  const run = frame("ZCL_FACADE", "RUN", 15);
  const nested = frame("ZCL_FACADE", "MODIFIER_FOR", 25);
  const timeline = [
    { stack: [root], cur: { owner: root.program, name: root.unit }, at: { url: root.url, line: root.line } },
    { stack: [nested, run, root], cur: { owner: nested.program, name: nested.unit }, at: { url: nested.url, line: nested.line } }
  ];
  const context = { flow: { timeline }, stepKey: t => t.cur.owner + "=>" + t.cur.name + ":" + t.at.line,
    stepText: f => f.program + ":" + f.line, shapeIn: () => null, closesBlock: () => false };
  vm.runInNewContext(helpers(html) + html.slice(start, end), context);
  const graph = context.stepFlow();
  // RUN is entered from the recorded statement that called it.
  assert.ok(graph.edges["ZREPORT=>ZREPORT:5>m|ZCL_FACADE=>RUN"]);
  assert.ok(graph.edges["m|ZCL_FACADE=>RUN>m|ZCL_FACADE=>MODIFIER_FOR"]);
  assert.ok(graph.edges["m|ZCL_FACADE=>MODIFIER_FOR>ZCL_FACADE=>MODIFIER_FOR:25"]);
});
