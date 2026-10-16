"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { namedObjects, collect, expandIncludes, writeProject } = require("../sap-transpile");
const { launch } = require("../local-run");

const system = {
  ZCALC: { object_type: "PROG", source: "REPORT zcalc.\nINCLUDE zcalc_top.\nDATA lo TYPE REF TO zcl_price.\n" +
    "lo = NEW zcl_price( ).\nWRITE lo->price( gv_n ).\n" },
  ZCALC_TOP: { object_type: "INCL", source: "CONSTANTS gc_rate TYPE i VALUE 10.\nDATA gv_n TYPE i.\nDATA gv_tag TYPE char12.\ngv_n = gc_rate.\n" },
  ZCL_PRICE: { object_type: "CLAS", includes: ["main", "definitions", "implementations", "testclasses"],
    source: "CLASS zcl_price DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES zif_price.\n" +
      "    METHODS price IMPORTING n TYPE i RETURNING VALUE(r) TYPE i.\nENDCLASS.\n" +
      "CLASS zcl_price IMPLEMENTATION.\n  METHOD price.\n    r = n * 10 + lcl_helper=>bonus( ).\n  ENDMETHOD.\nENDCLASS.\n",
    definitions: "CLASS lcl_helper DEFINITION.\n  PUBLIC SECTION.\n    CLASS-METHODS bonus RETURNING VALUE(r) TYPE i.\nENDCLASS.\n",
    implementations: "CLASS lcl_helper IMPLEMENTATION.\n  METHOD bonus.\n    r = 1.\n  ENDMETHOD.\nENDCLASS.\n" },
  ZIF_PRICE: { object_type: "INTF", source: "INTERFACE zif_price PUBLIC.\nENDINTERFACE.\n" }
};
const read = async ({ object_name, object_type, include = "main" }) => {
  const object = system[object_name];
  if (!object || object_type !== object.object_type) throw new Error(object_type + " " + object_name + " was not found.");
  return { object_name, object_type: object.object_type, includes: object.includes || [],
    source: include === "main" ? object.source : object[include] };
};
const program = source => async args => args.object_name === "ZCALC" ? { ...await read(args), source } : read(args);

test("names a program's customer classes, interfaces, includes and function modules", () => {
  const named = namedObjects("REPORT z.\nINCLUDE zx_top.\nINCLUDE TYPE zs.\nDATA r TYPE REF TO zcl_a.\n" +
    "CLASS lcl DEFINITION INHERITING FROM zcl_base.\nENDCLASS.\nTRY.\n  zcl_b=>run( ).\nCATCH zcx_one zcx_two INTO DATA(e).\nENDTRY.\n" +
    "* NEW zcl_comment( )\ncl_abap_typedescr=>describe_by_data( r ).\nCALL FUNCTION 'Z_RATE'.\nCALL FUNCTION 'BAPI_X'.\n");
  assert.deepEqual([...named.objects].sort(), [["ZCL_A", "REF"], ["ZCL_B", "CLAS"], ["ZCL_BASE", "CLAS"],
    ["ZCX_ONE", "CLAS"], ["ZCX_TWO", "CLAS"], ["ZX_TOP", "INCL"]]);
  assert.deepEqual(named.functions, ["Z_RATE"]);
});

test("collects the closure: includes, an interface named as a class, class includes without the tests", async () => {
  const sources = await collect(read, { name: "ZCALC", type: "PROG" });
  assert.deepEqual(sources.map(s => s.name + "." + s.include),
    ["ZCALC.main", "ZCALC_TOP.main", "ZCL_PRICE.main", "ZCL_PRICE.definitions", "ZCL_PRICE.implementations", "ZIF_PRICE.main"]);
});

test("what cannot be read or run stops the collection", async () => {
  const broken = async args => { if (args.object_name === "ZCL_PRICE") throw new Error("Session busy"); return read(args); };
  await assert.rejects(collect(broken, { name: "ZCALC", type: "PROG" }), /ZCL_PRICE: Session busy/);
  await assert.rejects(collect(program("REPORT zcalc.\nCALL FUNCTION 'Z_RATE'.\n"), { name: "ZCALC", type: "PROG" }),
    /function module Z_RATE/);
  // A REF TO that is no class or interface is the dictionary's: the collection goes on without it.
  const sources = await collect(program("REPORT zcalc.\nDATA r TYPE REF TO zflight.\n"), { name: "ZCALC", type: "PROG" });
  assert.deepEqual(sources.map(s => s.name), ["ZCALC"]);
});

test("includes are written into the program, each line keeping its file and line", () => {
  const texts = new Map([["ZP", "REPORT zp.\nINCLUDE zi1.\nWRITE 1.\n"], ["ZI1", "DATA a TYPE i.\n  INCLUDE zi2 .\n"], ["ZI2", "a = 2."]]);
  const expanded = expandIncludes("zp", texts);
  assert.deepEqual(expanded.files, ["ZP", "ZI1", "ZI2"]);
  assert.deepEqual(expanded.lines, ["REPORT zp.", "DATA a TYPE i.", "a = 2.", "", "WRITE 1.", ""]);
  assert.deepEqual(expanded.places, [[0, 1], [1, 1], [2, 1], [1, 3], [0, 3], [0, 4]]);
  assert.throws(() => expandIncludes("zp", new Map([["ZP", "WRITE 1. INCLUDE zi1."], ["ZI1", ""]])), /shares its line/);
  assert.throws(() => expandIncludes("zp", new Map([["ZP", "INCLUDE zp."]])), /includes itself/);
});

test("the collected program runs with the transpiler, stepping into its include and the class", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-sap-run-"));
  try {
    const file = writeProject("TEST", await collect(read, { name: "ZCALC", type: "PROG" }), [], folder);
    assert.equal(path.relative(folder, file), path.join("sap", "zcalc.prog.abap"));
    assert.equal(fs.readFileSync(file, "utf8"), system.ZCALC.source);
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8") };
    let log = "";
    const vscode = { workspace: { getWorkspaceFolder: () => undefined },
      window: { createOutputChannel: () => ({ append: t => { log += t; }, appendLine: t => { log += t + "\n"; }, hide() {}, show() {} }) } };
    const result = await launch(vscode, false, { document, selection: {}, trace: true })
      .catch(error => { throw new Error(error.message + "\n" + log); });
    assert.match(result.output, /101/);
    // The steps point at the lines of the sources as SAP holds them: the include, the class and its local include.
    const at = (name, line) => result.records.some(r => path.basename(r.file) === name && r.line === line);
    assert.ok(at("zcalc_top.prog.abap", 4), "the include's statement");
    assert.ok(at("zcalc.prog.abap", 4), "the program's statement after the include");
    assert.ok(at("zcl_price.clas.abap", 8), "METHOD price body");
    assert.ok(at("zcl_price.clas.locals_imp.abap", 3), "LCL_HELPER=>BONUS body");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("a method of an SAP class runs from the folder written for it, its result in the output", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-sap-method-"));
  try {
    const sources = await collect(read, { name: "ZCL_PRICE", type: "CLAS" });
    const file = writeProject("TEST", sources, [], folder);
    assert.equal(path.relative(folder, file), path.join("src", "zcl_price.clas.abap"));
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8"), isDirty: false };
    assert.ok(require("../local-run").entryScreen(document, 8), "line 8 is in METHOD price");
    let log = "";
    const vscode = { workspace: { getWorkspaceFolder: () => undefined },
      window: { createOutputChannel: () => ({ append: t => { log += t; }, appendLine: t => { log += t + "\n"; }, hide() {}, show() {} }) } };
    const result = await launch(vscode, false, { document, entryLine: 8, trace: true,
      selection: { $entry: { parameters: { N: "4" } } } }).catch(error => { throw new Error(error.message + "\n" + log); });
    assert.match(result.output, /41/);
    assert.ok(result.records.some(r => path.basename(r.file) === "zcl_price.clas.locals_imp.abap" && r.line === 3), "the method's call recorded");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("SAP's own classes come from the bundled open-abap-core, those the runtime raises too, and are not recorded", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-sap-core-"));
  try {
    const file = writeProject("TEST", [{ name: "ZSTD", type: "PROG", include: "main", text: "REPORT zstd.\n" +
      "DATA lv_n TYPE i.\nDATA lv_text TYPE string.\nDATA lx TYPE REF TO cx_sy_zerodivide.\nTRY.\n    lv_n = 1 / lv_n.\n" +
      "  CATCH cx_sy_zerodivide INTO lx.\n" +
      "    lv_text = lx->get_text( ).\nENDTRY.\nIF strlen( cl_abap_char_utilities=>newline ) = 1.\n  WRITE / 'newline'.\nENDIF.\n" +
      "WRITE / lv_text.\n" }], [], folder);
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8") };
    let log = "";
    const vscode = { workspace: { getWorkspaceFolder: () => undefined },
      window: { createOutputChannel: () => ({ append: t => { log += t; }, appendLine: t => { log += t + "\n"; }, hide() {}, show() {} }) } };
    const result = await launch(vscode, false, { document, selection: {}, trace: true })
      .catch(error => { throw new Error(error.message + "\n" + log); });
    assert.match(result.output, /newline/);
    assert.ok(result.records.every(r => !/open-abap-core/i.test(r.file)), "no step inside the library");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("a run that fails says where in the ABAP, not where in the generated JavaScript", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-sap-fail-"));
  try {
    const sources = [{ name: "ZFAIL", type: "PROG", include: "main", text: "REPORT zfail.\nDATA lo TYPE REF TO zcl_boom.\n" +
      "lo = NEW zcl_boom( ).\nlo->go( ).\n" },
      { name: "ZCL_BOOM", type: "CLAS", include: "main", text: "CLASS zcl_boom DEFINITION PUBLIC.\n  PUBLIC SECTION.\n" +
        "    METHODS go.\nENDCLASS.\nCLASS zcl_boom IMPLEMENTATION.\n  METHOD go.\n    DATA lo TYPE REF TO zcl_boom.\n" +
        "    lo->go( ).\n  ENDMETHOD.\nENDCLASS.\n" }];
    const file = writeProject("TEST", sources, [], folder);
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8") };
    const vscode = { workspace: { getWorkspaceFolder: () => undefined },
      window: { createOutputChannel: () => ({ append() {}, appendLine() {}, hide() {}, show() {} }) } };
    await assert.rejects(launch(vscode, false, { document, selection: {}, trace: true }), error => {
      assert.match(error.message, /\n  at ZCL_BOOM line 8 \(zcl_boom\.clas\.abap\)\n  called from ZFAIL line 4 \(zfail\.prog\.abap\)/);
      return true;
    });
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
