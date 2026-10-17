"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createParser } = require("../value-origin-linter");
const { analyze } = require("../value-origin");

test("a routine's declarations reach its ENDMETHOD, past a statement over several lines", async () => {
  const text = ["CLASS zcl_r DEFINITION PUBLIC FINAL CREATE PUBLIC.", "  PUBLIC SECTION.", "    METHODS get IMPORTING iv TYPE i.", "ENDCLASS.",
    "CLASS zcl_r IMPLEMENTATION.", "  METHOD get.", "    DATA(lv) = iv.", "    SELECT f", "      FROM ztab", "      INTO @DATA(rows).", "  ENDMETHOD.", "ENDCLASS."].join("\n");
  const parser = createParser();
  let source;
  try { source = (await parser.parse({ id: "r", name: "ZCL_R", objectName: "ZCL_R", objectType: "CLAS", text })).source; }
  finally { await parser.close(); }
  const get = analyze([source], { source: "r", line: 1, variable: "", column: 0, declarationTypes: true }).declarations.find(d => d.name === "GET");
  assert.deepEqual([get.first, get.last], [6, 11]);
});

test("a method's parameters written with ! (IMPORTING !is_x) are its parameters", async () => {
  const text = ["CLASS zcl_r DEFINITION PUBLIC FINAL CREATE PUBLIC.", "  PRIVATE SECTION.",
    "    METHODS get IMPORTING !is_p TYPE p9015 EXPORTING !ev_amount TYPE pad_amt7s !ev_deduction TYPE pad_amt7s.", "ENDCLASS.",
    "CLASS zcl_r IMPLEMENTATION.", "  METHOD get.", "    CLEAR ev_amount.", "  ENDMETHOD.", "ENDCLASS."].join("\n");
  const parser = createParser();
  let source;
  try { source = (await parser.parse({ id: "r", name: "ZCL_R", objectName: "ZCL_R", objectType: "CLAS", text })).source; }
  finally { await parser.close(); }
  const get = analyze([source], { source: "r", line: 1, variable: "", column: 0, declarationTypes: true }).declarations.find(d => d.name === "GET");
  assert.deepEqual(get.params.map(p => p.mode + " " + p.name + " " + p.type), ["IMPORTING IS_P p9015", "EXPORTING EV_AMOUNT pad_amt7s", "EXPORTING EV_DEDUCTION pad_amt7s"]);
});
