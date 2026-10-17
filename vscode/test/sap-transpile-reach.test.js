"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { collect } = require("../sap-transpile");

// A system of sources, read as the analysis reader answers.
const system = {
  ZCL_ROOT: ["CLASS zcl_root DEFINITION PUBLIC FINAL CREATE PUBLIC.", "  PUBLIC SECTION.", "    METHODS run RETURNING VALUE(rv) TYPE i.",
    "    METHODS other.", "  PRIVATE SECTION.", "    DATA mo_kept TYPE REF TO zcl_attr_used.", "    DATA mo_idle TYPE REF TO zcl_attr_idle.", "ENDCLASS.",
    "CLASS zcl_root IMPLEMENTATION.", "  METHOD run.", "    rv = zcl_used=>calc( ) + helper( ).", "    mo_kept->go( ).", "  ENDMETHOD.",
    "  METHOD helper.", "    rv = 1.", "  ENDMETHOD.", "  METHOD other.", "    NEW zcl_unused( ).", "  ENDMETHOD.", "ENDCLASS."].join("\n"),
  ZCL_USED: "CLASS zcl_used DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    CLASS-METHODS calc RETURNING VALUE(rv) TYPE i.\n    CLASS-METHODS spare.\nENDCLASS.\n"
    + "CLASS zcl_used IMPLEMENTATION.\n  METHOD calc.\n    rv = 2.\n  ENDMETHOD.\n  METHOD spare.\n    NEW zcl_spare_dep( ).\n  ENDMETHOD.\nENDCLASS.",
  ZCL_ATTR_USED: "CLASS zcl_attr_used DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS go.\nENDCLASS.\nCLASS zcl_attr_used IMPLEMENTATION.\n  METHOD go.\n  ENDMETHOD.\nENDCLASS.",
  ZCL_ATTR_IDLE: "CLASS zcl_attr_idle DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_attr_idle IMPLEMENTATION.\nENDCLASS.",
  ZCL_UNUSED: "CLASS zcl_unused DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_unused IMPLEMENTATION.\nENDCLASS.",
  ZCL_SPARE_DEP: "CLASS zcl_spare_dep DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_spare_dep IMPLEMENTATION.\nENDCLASS."
};
const asked = [];
const read = async ({ object_name, object_type, include }) => {
  asked.push(object_name);
  if (!system[object_name] || object_type !== "CLAS") throw new Error(object_type + " " + object_name + " was not found.");
  return { object_name, object_type: "CLAS", source: system[object_name], includes: [] };
};

test("a run reads what its method reaches: the classes it calls and the attributes it uses, not the rest", async () => {
  asked.length = 0;
  const lines = system.ZCL_ROOT.split("\n"), runLine = lines.findIndex(l => l.includes("rv = zcl_used")) + 1;
  const sources = await collect(read, { name: "ZCL_ROOT", type: "CLAS" }, { entryLine: runLine });
  assert.deepEqual([...new Set(sources.map(s => s.name))].sort(), ["ZCL_ATTR_USED", "ZCL_ROOT", "ZCL_USED"]);
  assert.equal(asked.includes("ZCL_UNUSED"), false, "a class only another method names is not read");
  assert.equal(asked.includes("ZCL_SPARE_DEP"), false, "what an uncalled method of a read class names is not read");
  assert.equal(asked.includes("ZCL_ATTR_IDLE"), false, "an attribute nothing reached uses is not read");
});

test("with no entry line every method of the class starts the run", async () => {
  asked.length = 0;
  const sources = await collect(read, { name: "ZCL_ROOT", type: "CLAS" }, {});
  assert.ok(sources.some(s => s.name === "ZCL_UNUSED"));
});

test("an unreached method keeps its lines but not its body: one failing line where the body was", async () => {
  const lines = system.ZCL_ROOT.split("\n"), runLine = lines.findIndex(l => l.includes("rv = zcl_used")) + 1;
  const sources = await collect(read, { name: "ZCL_ROOT", type: "CLAS" }, { entryLine: runLine });
  const root = sources.find(s => s.name === "ZCL_ROOT").text.split("\n"), used = sources.find(s => s.name === "ZCL_USED").text;
  assert.equal(root.length, lines.length, "every line keeps its number");
  const other = lines.findIndex(l => l.includes("NEW zcl_unused"));
  assert.match(root[other], /^ASSERT 1 = 2\. " VERTEX: not transpiled/);
  assert.ok(root.some(l => l.includes("rv = zcl_used=>calc( ) + helper( ).")), "the reached method keeps its body");
  assert.ok(root.some(l => l.includes("rv = 1.")), "a method the reached one calls keeps its body");
  assert.equal(used.includes("NEW zcl_spare_dep"), false, "the uncalled method of a read class has no body");
  assert.ok(used.includes("rv = 2."));
});
