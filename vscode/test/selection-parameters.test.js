"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectionParameters, radioGroups } = require("../value-origin-model");

test("a selection screen's plain parameters and checkboxes are read with their defaults; radio buttons are not among them", () => {
  const text = ["REPORT test.",
    "PARAMETERS p_clean(10) TYPE c DEFAULT 'ab'.",
    "PARAMETERS p_low(10) TYPE c LOWER CASE.",
    "PARAMETERS p_n TYPE i DEFAULT 5.",
    "PARAMETERS p_x AS CHECKBOX DEFAULT 'X'.",
    "PARAMETERS r_a RADIOBUTTON GROUP g1 DEFAULT 'X'.",
    "PARAMETERS r_b RADIOBUTTON GROUP g1."].join("\n");
  const found = selectionParameters([{ id: "t", text }]);
  assert.deepEqual(found, [
    { name: "P_CLEAN", kind: "value", default: "ab", numeric: false, upper: true },
    { name: "P_LOW", kind: "value", default: "", numeric: false, upper: false },
    { name: "P_N", kind: "value", default: "5", numeric: true, upper: false },
    { name: "P_X", kind: "checkbox", default: "X", numeric: false, upper: false }]);
  assert.deepEqual(radioGroups([{ id: "t", text }]).map(g => g.group), ["G1"]);
});
