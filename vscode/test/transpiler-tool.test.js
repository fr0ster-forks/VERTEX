"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const tool = require("../transpiler-tool");

test("transpiler agent tool requires an explicit class method line", () => {
  assert.throws(() => tool.validate({ object_type: "CLAS", object_name: "ZCL_CALC_FACADE" }), /entry_line/);
  assert.deepEqual(tool.validate({ object_type: "CLAS", object_name: "zcl_calc_facade", entry_line: 31 }), {
    object_name: "ZCL_CALC_FACADE", object_type: "CLAS", entryLine: 31, selection: {}
  });
});

test("transpiler agent tool describes selection screen and asks for required inputs", () => {
  const screen = { texts: { selections: { P_ID: "Shipment" } }, elements: [
    { kind: "parameter", name: "P_CLEAN", radio: "SC", default: "X" },
    { kind: "parameter", name: "P_ID", obligatory: true, default: "" },
    { kind: "select-option", name: "S_DATE", obligatory: true, default: null }
  ] };
  assert.deepEqual(tool.missingSelection(screen, {}), ["P_ID", "S_DATE"]);
  assert.deepEqual(tool.missingSelection(screen, { $parameters: { P_ID: "42" },
    $ranges: { S_DATE: [{ sign: "I", option: "EQ", low: "20261018" }] } }), []);
  assert.equal(tool.describeScreen(screen)[1].label, "Shipment");
});

test("transpiler agent tool asks for required method arguments", () => {
  const entry = { creation: [], parameters: [
    { name: "IV_SCENARIO", direction: "importing", optional: false },
    { name: "EV_RESULT", direction: "exporting", optional: false }
  ] };
  assert.deepEqual(tool.missingEntry(entry, {}), ["IV_SCENARIO"]);
  assert.deepEqual(tool.missingEntry(entry, { $entry: { parameters: { IV_SCENARIO: "CLEAN" } } }), []);
});

test("source acquisition queue orders requests and recovers after failure", async () => {
  const queue = tool.createRunQueue();
  const order = [];
  const first = queue(async () => { order.push("first"); throw new Error("read failed"); });
  const second = queue(async () => { order.push("second"); return 2; });
  assert.equal((await Promise.allSettled([first, second]))[1].value, 2);
  assert.deepEqual(order, ["first", "second"]);
});
