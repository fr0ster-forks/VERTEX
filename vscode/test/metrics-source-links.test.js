"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "../../org.vertex.abap.ui/resources/metrics.html"), "utf8");
const source = page.slice(page.indexOf("function makeTable("), page.indexOf("function classMetrics("));

test("package Metrics method links open their owning object beside the table", () => {
  const opened = [];
  const element = tag => ({ tag, children: [], textContent: "", style: {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute() {}, addEventListener(name, fn) { this[name] = fn; } });
  const context = vm.createContext({ document: { createElement: element }, chosenKey: null,
    partKeyOf: value => value, cellValue: row => row.unit_name, METRIC_LIMITS: {},
    rounded: value => String(value), metricGrade: () => "", loadedObject: "SRC", loadedType: "DEVC",
    sdeOpenToolSource: args => opened.push(args) });
  vm.runInContext(source, context);
  const table = context.makeTable([{ key: "unit_name", text: "Method", num: false }],
    [{ unit_name: "ZCL_MOD_FUEL=>ZIF_CALC_MODIFIER~APPLY" }], null, true, null,
    { name: "ZCL_MOD_FUEL", type: "CLAS" });
  const find = node => node.tag === "button" ? node : node.children.map(find).find(Boolean);
  find(table).click();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ name: "ZCL_MOD_FUEL", type: "CLAS",
    method: "ZIF_CALC_MODIFIER~APPLY", beside: true, preserveFocus: true }]);
});
