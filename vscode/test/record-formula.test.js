"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { build } = require("../record-formula");

const page = fs.readFileSync(path.join(__dirname, "../pages/visual-debug.html"), "utf8");
const part = (from, to) => page.slice(page.indexOf(from), page.indexOf(to));

const source = ["REPORT zlab.", "PARAMETERS p_prec AS CHECKBOX.", "DATA lv_rate TYPE i.", "START-OF-SELECTION.",
  "  lv_rate = 3.", "  DATA(lv_scenario) = COND char12( WHEN p_prec = abap_true THEN 'PRECISION'", "                                    ELSE 'CLEAN' ).",
  "  DATA(lv_total) = lv_rate * 10.", "  WRITE lv_total."].join("\n");

// A transpiler record: the values that changed before each stop's statement ran.
const stop = (line, changed) => ({ at: { url: "zlab.prog.abap", line }, cur: { owner: "ZLAB", name: "START-OF-SELECTION" },
  stack: [{ program: "ZLAB" }], varsDelta: true, vars: [{ name: "Locals", children: Object.entries(changed).map(([name, value]) => ({ name, value })) }] });
const timeline = [stop(5, { p_prec: "", lv_rate: 0, lv_scenario: "", lv_total: 0 }), stop(6, { lv_rate: 3 }), stop(8, { lv_scenario: "CLEAN" }), stop(9, { lv_total: 30 })];

function steps() {
  const context = vm.createContext({ flow: { timeline } });
  vm.runInContext(part("function recordSteps(){", "function withRecordFormula(data){"), context);
  return vm.runInContext("recordSteps()", context);
}

test("the record gives each stop the whole set of values, built from the changes", () => {
  const all = steps();
  assert.equal(all.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(all[3].values)), { P_PREC: "", LV_RATE: 3, LV_SCENARIO: "CLEAN", LV_TOTAL: 30 });
  assert.equal(all[2].location, "ZLAB=>START-OF-SELECTION");
});

test("a value is derived from the statement that changed it and what that statement read", () => {
  const result = build({ variable: "LV_TOTAL", steps: steps(), sources: { "zlab.prog.abap": source } });
  assert.equal(result.tree.of, "LV_TOTAL");
  assert.equal(result.tree.value, "30");
  assert.equal(result.tree.line, 8);
  assert.match(result.tree.text, /lv_rate \* 10/);
  const rate = result.tree.children.find(child => child.of === "LV_RATE");
  assert.ok(rate, "the operand it read");
  assert.equal(rate.value, "3");
  assert.equal(rate.line, 5);
  assert.match(result.panes.formula, /From the run/);
  assert.match(result.panes.expression, /lv_rate = 3/);
  assert.equal(result.formula.edges.length, result.formula.nodes.length - 1);
});

test("a statement over several lines is read whole", () => {
  const result = build({ variable: "LV_SCENARIO", steps: steps(), sources: { "zlab.prog.abap": source } });
  assert.equal(result.tree.line, 6);
  assert.match(result.tree.text, /ELSE 'CLEAN'/);
  assert.ok(result.tree.children.some(child => child.of === "P_PREC" && child.outside), "a parameter never changed in the record is where it started");
});

test("a record without values says how to get them", () => {
  assert.throws(() => build({ variable: "LV_TOTAL", steps: [] }), /Steps & values/);
});
