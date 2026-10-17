"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { groupXml, moduleParameters } = require("../sap-fugr");
const { createParser } = require("../value-origin-linter");
const { analyze } = require("../value-origin");

test("a local function module's parameters come from its group's XML, and the analysis declares them", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-fugr-"));
  const parts = { IMPORTING: [{ name: "IV_TRANSPORT", type: "CHAR4" }], EXPORTING: [{ name: "EV_AMOUNT", type: "DECFLOAT34" }],
    CHANGING: [{ name: "CV_NOTE", type: "STRING" }], TABLES: [], EXCEPTIONS: [] };
  fs.writeFileSync(path.join(folder, "zvx_calc.fugr.xml"), groupXml("ZVX_CALC", [{ kind: "module", signature: { name: "Z_VX_FREIGHT", parts } }]));
  const file = path.join(folder, "zvx_calc.fugr.z_vx_freight.abap");
  const text = "FUNCTION z_vx_freight.\n  DATA lv TYPE i.\n  ev_amount = lv.\nENDFUNCTION.";
  fs.writeFileSync(file, text);
  try {
    const params = moduleParameters(file);
    assert.deepEqual(params.map(p => p.mode + " " + p.name + " " + p.type),
      ["IMPORTING IV_TRANSPORT CHAR4", "EXPORTING EV_AMOUNT DECFLOAT34", "CHANGING CV_NOTE STRING"]);
    const parser = createParser();
    let source;
    try { source = (await parser.parse({ id: "f", name: "Z_VX_FREIGHT", objectName: "Z_VX_FREIGHT", objectType: "PROG", text, functionParams: params })).source; }
    finally { await parser.close(); }
    const module = analyze([source], { source: "f", line: 1, variable: "", column: 0, declarationTypes: true }).declarations.find(d => d.name === "Z_VX_FREIGHT");
    assert.deepEqual(module.params.map(p => p.name), ["IV_TRANSPORT", "EV_AMOUNT", "CV_NOTE"]);
    assert.deepEqual(module.locals.map(l => l.name.toUpperCase()), ["LV"]);
    assert.deepEqual(moduleParameters(path.join(folder, "other.prog.abap")), []);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("a function module read from SAP declares the interface its FUNCTION statement writes", async () => {
  const text = "FUNCTION z_fm\n  IMPORTING\n    VALUE(iv_amount) TYPE decfloat34 DEFAULT 10\n  EXPORTING\n    VALUE(ev_payment) TYPE decfloat34\n"
    + "  CHANGING\n    REFERENCE(cv_note) TYPE string\n  TABLES\n    et_rows STRUCTURE bapiret2\n  EXCEPTIONS\n    invalid_input.\n  DATA lv TYPE i.\nENDFUNCTION.";
  const parser = createParser();
  let source;
  try { source = (await parser.parse({ id: "s", name: "Z_FM", objectName: "Z_FM", objectType: "FUNC", text })).source; }
  finally { await parser.close(); }
  const module = analyze([source], { source: "s", line: 1, variable: "", column: 0, declarationTypes: true }).declarations.find(d => d.name === "Z_FM");
  assert.deepEqual(module.params.map(p => p.mode + " " + p.name + " " + p.type),
    ["IMPORTING IV_AMOUNT DECFLOAT34", "EXPORTING EV_PAYMENT DECFLOAT34", "CHANGING CV_NOTE STRING", "TABLES ET_ROWS BAPIRET2"]);
});

test("a FUNCTION statement's types keep their owner and REF TO, and abaplint's Unknown on it is no warning", async () => {
  const text = "FUNCTION z_fm\n  IMPORTING\n    is_context TYPE zif_calc_types=>ty_context\n    io_log TYPE REF TO zcl_log\n    iv_rate TYPE i DEFAULT 2.\nENDFUNCTION.";
  const parser = createParser();
  let parsed;
  try { parsed = await parser.parse({ id: "t", name: "Z_FM", objectName: "Z_FM", objectType: "FUNC", text }); }
  finally { await parser.close(); }
  assert.deepEqual(parsed.warnings, []);
  const module = analyze([parsed.source], { source: "t", line: 1, variable: "", column: 0, declarationTypes: true }).declarations.find(d => d.name === "Z_FM");
  assert.deepEqual(module.params.map(p => p.name + " " + p.type), ["IS_CONTEXT ZIF_CALC_TYPES=>TY_CONTEXT", "IO_LOG REF TO ZCL_LOG", "IV_RATE I"]);
});
