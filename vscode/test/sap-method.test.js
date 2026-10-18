"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { extract } = require("../sap-method");

const source = "CLASS zcl_test IMPLEMENTATION.\n  METHOD first.\n    first( ).\n  ENDMETHOD.\n  METHOD zif_test~second.\n    DATA(lv_value) = 1.\n    lv_value += 2.\n  ENDMETHOD.\nENDCLASS.";

test("reads only the requested ABAP method", () => {
  const result = extract(source, "ZIF_TEST~SECOND");
  assert.equal(result.found, true);
  assert.equal(result.source, "  METHOD zif_test~second.\n    DATA(lv_value) = 1.\n    lv_value += 2.\n  ENDMETHOD.");
  assert.equal(result.start_line, 5);
  assert.equal(result.end_line, 8);
  assert.equal(result.next_line, null);
});

test("pages a long method without returning the full source", () => {
  const first = extract(source, "zif_test~second", 1, 2);
  const second = extract(source, "zif_test~second", first.next_line, 2);
  assert.equal(first.source, "  METHOD zif_test~second.\n    DATA(lv_value) = 1.");
  assert.equal(first.next_line, 3);
  assert.equal(second.source, "    lv_value += 2.\n  ENDMETHOD.");
  assert.equal(second.next_line, null);
});

test("unknown method reports available names", () => {
  assert.deepEqual(extract(source, "missing").available_methods, ["FIRST", "ZIF_TEST~SECOND"]);
});
