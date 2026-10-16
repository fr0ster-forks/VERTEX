"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createExtensionRepository, buildIndex, createIndex, objectAt, parseSourceUrl } = require("../sap-adt-extension-repository");

/* The extension's tree of one destination, as folders (objects) and files (strings). */
function tree() {
  return { A4H: {
    "Local Objects ($TMP)": { DEVELOPER: { "Source Code Library": {
      Programs: { Z_PROBE: { "z_probe.prog.abap": "REPORT z_probe.\nWRITE 1.", "z_probe.prog.json": "{}" } } } } },
    "System Library": {
      "(BASIS)STRUCTURE": { "Source Code Library": { Classes: { CL_STANDARD: { "cl_standard.clas.abap": "standard" } } } },
      BASIS: { SABAPDEMOS: { "Source Code Library": { Programs: { DEMO_X: { "demo_x.prog.abap": "REPORT demo_x." } } } } },
      Z_APP: {
        "Source Code Library": {
          Classes: { ZCL_APP: { "zcl_app.clas.abap": "CLASS zcl_app DEFINITION.", "zcl_app.clas.implementations.abap": "local imp", "zcl_app.clas.json": "{}" } },
          Interfaces: { ZIF_APP: { "zif_app.intf.abap": "INTERFACE zif_app." } },
          "Function Groups": { Z_FG: { "z_fg.fugr.z_fm_one.func.abap": "FUNCTION z_fm_one.", "z_fg.fugr.saplz_fg.reps.abap": "main", "z_fg.fugr.lz_fgtop.reps.abap": "top" } } },
        Dictionary: {},
        Z_APP_SUB: { "Source Code Library": { Includes: { Z_APP_INC: { "z_app_inc.prog.abap": "* include" } } } } } } } };
}
function fakeHost(root = tree(), { diagnostics = [], activeAfter = text => text, dropWrites = false } = {}) {
  const calls = [];
  const node = segments => segments.reduce((at, name) => {
    if (!at || typeof at !== "object" || !(name in at)) throw new Error("FileNotFound " + segments.join("/"));
    return at[name];
  }, root);
  return { calls,
    progress: () => {},
    readDirectory: async segments => { calls.push("ls " + segments.join("/")); return Object.entries(node(segments)).map(([n, v]) => [n, typeof v === "object" ? 2 : 1]); },
    readFile: async segments => node(segments),
    write: async (segments, text) => { calls.push("write " + segments.at(-1)); if (!dropWrites) node(segments.slice(0, -1))[segments.at(-1)] = text; },
    check: async segments => { calls.push("check " + segments.at(-1)); return diagnostics; },
    activate: async segments => { calls.push("activate " + segments.at(-1)); },
    activeText: async segments => activeAfter(node(segments)) };
}
// Z_APP is named, as a reader names the packages they work in: its objects are found by name.
const system = { name: "A4H_SNC", connection: "sap-adt-extension", destination: "A4H", packages: ["Z_APP"] };

test("the index holds $TMP and the customer packages with their subpackages, and leaves standard SAP out", async () => {
  const index = await buildIndex(fakeHost(), "A4H");
  assert.deepEqual([...index.objects.keys()].sort(),
    ["CLAS:ZCL_APP", "FUGR:Z_FG", "FUNC:Z_FM_ONE", "INCL:Z_APP_INC", "INTF:ZIF_APP", "PROG:Z_PROBE"]);
  assert.equal(index.objects.get("PROG:Z_PROBE").package, "$TMP");
  assert.equal(index.objects.get("INCL:Z_APP_INC").package, "Z_APP_SUB");
  assert.equal(index.objects.get("FUNC:Z_FM_ONE").group, "Z_FG");
});

test("a package named by the system is walked by its path; one that is not there is said", async () => {
  const index = await buildIndex(fakeHost(), "A4H", ["BASIS/SABAPDEMOS", "BASIS/NOPE", "SAPNOT"]);
  assert.equal(index.objects.get("PROG:DEMO_X").package, "SABAPDEMOS");
  assert.deepEqual(index.problems, ["package BASIS/NOPE: NOPE is not under BASIS", "package SAPNOT is not a root package of the System Library"]);
});

test("a destination not logged on is refused, not indexed as empty", async () => {
  await assert.rejects(buildIndex(fakeHost({ A4H: {} }), "A4H"), /log on to it there first/);
});

test("reading answers as ADT's repository does: ADT addresses, the class parts there are, the source", async () => {
  const repo = createExtensionRepository({ system, host: fakeHost() });
  const main = await repo.execute("read_sap_object", { object_type: "CLAS", object_name: "zcl_app" });
  assert.equal(main.object_url, "/sap/bc/adt/oo/classes/zcl_app");
  assert.equal(main.source_url, "/sap/bc/adt/oo/classes/zcl_app/source/main");
  assert.deepEqual(main.includes, ["main", "implementations"]);
  assert.equal(main.package, "Z_APP");
  const imp = await repo.execute("read_sap_object", { object_type: "CLAS", object_name: "ZCL_APP", include: "implementations" });
  assert.equal(imp.source, "local imp");
  assert.equal(imp.source_url, "/sap/bc/adt/oo/classes/zcl_app/includes/implementations");
  const fm = await repo.execute("read_sap_object", { object_type: "FUNC", object_name: "Z_FM_ONE" });
  assert.equal(fm.object_url, "/sap/bc/adt/functions/groups/z_fg/fmodules/z_fm_one");
  assert.equal(fm.source, "FUNCTION z_fm_one.");
});

test("an ADT source address is read from its file, function group includes too", async () => {
  const repo = createExtensionRepository({ system, host: fakeHost() });
  assert.equal(await repo.sourceAt("/sap/bc/adt/oo/interfaces/zif_app/source/main"), "INTERFACE zif_app.");
  assert.equal(await repo.sourceAt("/sap/bc/adt/functions/groups/z_fg/source/main"), "main");
  assert.equal(await repo.sourceAt("/sap/bc/adt/functions/groups/z_fg/includes/lz_fgtop/source/main"), "top");
  await assert.rejects(repo.sourceAt("/sap/bc/adt/textelements/programs/z_probe/source/selections"), /only with SAP ADT extension/);
  assert.deepEqual(parseSourceUrl("/sap/bc/adt/oo/classes/%2fabc%2fcl_x/includes/macros"), { type: "CLAS", name: "/ABC/CL_X", include: "macros" });
});

test("search finds indexed names by pattern; an object outside the index is not found, with what was indexed", async () => {
  const repo = createExtensionRepository({ system, host: fakeHost() });
  const found = await repo.execute("search_sap_objects", { query: "Z*APP*" });
  assert.deepEqual(found.objects.map(o => o.object_name).sort(), ["ZCL_APP", "ZIF_APP", "Z_APP_INC"]);
  await assert.rejects(repo.execute("read_sap_object", { object_type: "CLAS", object_name: "CL_STANDARD" }), /CL_STANDARD was not found in A4H \(looked in the \$TMP of this user, the packages of the objects worked on, Z_APP/);
});

test("a package's classes and interfaces come from the index", async () => {
  const repo = createExtensionRepository({ system, host: fakeHost() });
  assert.deepEqual(await repo.packageObjects("z_app"), [{ object_name: "ZCL_APP", object_type: "CLAS" }, { object_name: "ZIF_APP", object_type: "INTF" }]);
  await assert.rejects(repo.packageObjects("Z_NONE"), /not found among the indexed packages/);
});

async function prepared(host) {
  const repo = createExtensionRepository({ system, host });
  const read = await repo.execute("read_sap_object", { object_type: "PROG", object_name: "Z_PROBE" });
  const draft = await repo.execute("modify_sap_object", { object_type: "PROG", object_name: "Z_PROBE", source: "REPORT z_probe.\nWRITE 2.", base_revision: read.revision });
  return { repo, draft };
}

test("apply writes, reads back, checks, activates and confirms the active source", async () => {
  const host = fakeHost();
  const { repo, draft } = await prepared(host);
  const result = await repo.apply(draft.change_id, { source: "REPORT z_probe.\nWRITE 2." });
  assert.equal(result.activated, true);
  assert.deepEqual(host.calls.filter(c => !c.startsWith("ls ")), ["write z_probe.prog.abap", "check z_probe.prog.abap", "activate z_probe.prog.abap"]);
});

test("a syntax error stops before activation, so the extension never asks to activate anyway", async () => {
  const host = fakeHost(tree(), { diagnostics: [{ severity: "error", line: 2, message: "Field \"X\" is unknown." }] });
  const { repo, draft } = await prepared(host);
  await assert.rejects(repo.apply(draft.change_id, { source: "REPORT z_probe.\nWRITE 2." }),
    /Syntax check failed, so activation was not requested: Line 2: Field "X" is unknown\. SAP source was written \(inactive\)/);
  assert.equal(host.calls.some(c => c.startsWith("activate")), false);
});

test("a write the extension drops is caught by reading back", async () => {
  const { repo, draft } = await prepared(fakeHost(tree(), { dropWrites: true }));
  await assert.rejects(repo.apply(draft.change_id, { source: "REPORT z_probe.\nWRITE 2." }), /did not store the source/);
});

test("an activation that leaves another active source is not reported as done", async () => {
  const { repo, draft } = await prepared(fakeHost(tree(), { activeAfter: () => "REPORT z_probe.\nWRITE 1." }));
  await assert.rejects(repo.apply(draft.change_id, { source: "REPORT z_probe.\nWRITE 2." }), /active source differs/);
});

test("what the extension does not give is refused with the reason; hover helpers are absent", async () => {
  const repo = createExtensionRepository({ system, host: fakeHost() });
  await assert.rejects(async () => repo.query("SELECT * FROM t000", 10), /Data preview is not available: System A4H_SNC is connected only with SAP ADT extension/);
  await assert.rejects(repo.execute("create_sap_object", {}), /Creating objects is not available/);
  assert.throws(() => repo.whereUsed("/sap/bc/adt/oo/classes/zcl_app/source/main", 1, 0), /Where-used is not available/);
  assert.equal(repo.elementInfo, undefined);
  assert.equal(await repo.canStore(), false);
});

test("a name is looked for near only: $TMP, then the package worked on outward; never another root package", async () => {
  const host = fakeHost();
  const index = createIndex({ fs: host, destination: "A4H" });
  assert.equal((await index.find("PROG", "Z_PROBE")).package, "$TMP");
  assert.equal(await index.find("INCL", "Z_APP_INC"), null, "Z_APP is no package worked on, so it is not walked");
  assert.equal(host.calls.some(c => c.includes("Z_APP")), false);
  index.prefer(["A4H", "System Library", "Z_APP"]);
  assert.equal((await index.find("INCL", "Z_APP_INC")).package, "Z_APP_SUB");
  assert.equal(host.calls.some(c => c.includes("BASIS")), false, "another root package is never walked for a name");
});

test("a finished index is kept by the store; an object it does not hold walks again", async () => {
  let kept = null;
  const store = { load: () => kept, save: value => { kept = JSON.parse(JSON.stringify(value)); } };
  await createIndex({ fs: fakeHost(), destination: "A4H", store }).refresh();
  assert.equal(kept.objects.length, 6);
  const quiet = fakeHost();
  const again = createIndex({ fs: quiet, destination: "A4H", store });
  assert.equal((await again.find("CLAS", "ZCL_APP")).package, "Z_APP");
  assert.deepEqual(quiet.calls, [], "the kept index answered without a walk");
  const root = tree();
  root.A4H["System Library"].Z_APP["Source Code Library"].Classes.ZCL_NEW = { "zcl_new.clas.abap": "new" };
  const fresh = createIndex({ fs: fakeHost(root), destination: "A4H", store });
  fresh.prefer(["A4H", "System Library", "Z_APP"]);
  assert.equal((await fresh.find("CLAS", "ZCL_NEW")).package, "Z_APP");
});

test("a path of the extension's tree names its object, part and package, or its package", () => {
  assert.deepEqual(objectAt(["A4H", "System Library", "Z_APP", "Source Code Library", "Classes", "ZCL_APP", "zcl_app.clas.implementations.abap"]),
    { kind: "object", type: "CLAS", name: "ZCL_APP", path: ["A4H", "System Library", "Z_APP", "Source Code Library", "Classes", "ZCL_APP"], package: "Z_APP", include: "implementations" });
  assert.equal(objectAt(["A4H", "Local Objects ($TMP)", "DEVELOPER", "Source Code Library", "Programs", "Z_PROBE"]).package, "$TMP");
  assert.deepEqual(objectAt(["A4H", "System Library", "Z_APP", "Source Code Library", "Function Groups", "Z_FG", "z_fg.fugr.z_fm_one.func.abap"]),
    { kind: "object", type: "FUNC", name: "Z_FM_ONE", group: "Z_FG", path: ["A4H", "System Library", "Z_APP", "Source Code Library", "Function Groups", "Z_FG"], file: "z_fg.fugr.z_fm_one.func.abap", package: "Z_APP", include: "main" });
  assert.deepEqual(objectAt(["A4H", "System Library", "Z_APP", "Z_APP_SUB"]), { kind: "package", name: "Z_APP_SUB", path: ["A4H", "System Library", "Z_APP", "Z_APP_SUB"] });
  assert.equal(objectAt(["A4H", "System Library", "Z_APP", "Source Code Library"]), null);
});

test("a package opened from the tree gives its objects without walking the others", async () => {
  const host = fakeHost();
  const repo = createExtensionRepository({ system, host });
  await repo.addPackage(["A4H", "System Library", "Z_APP"], "Z_APP");
  assert.deepEqual(await repo.packageObjects("Z_APP"), [{ object_name: "ZCL_APP", object_type: "CLAS" }, { object_name: "ZIF_APP", object_type: "INTF" }]);
  assert.equal(host.calls.some(c => c.includes("Local Objects")), false);
});

test("a name is looked for first in the root package of the object being worked on", async () => {
  const root = tree();
  root.A4H["System Library"].Z_AAA = { "Source Code Library": { Programs: { Z_AAA_PROG: { "z_aaa_prog.prog.abap": "REPORT z_aaa_prog." } } } };
  root.A4H["System Library"].Z_APP["Source Code Library"].Interfaces.ZIF_NEAR = { "zif_near.intf.abap": "INTERFACE zif_near." };
  const host = fakeHost(root);
  const repo = createExtensionRepository({ system, host });
  repo.seed({ kind: "object", type: "CLAS", name: "ZCL_APP", path: ["A4H", "System Library", "Z_APP", "Source Code Library", "Classes", "ZCL_APP"], package: "Z_APP" });
  assert.equal(await repo.sourceAt("/sap/bc/adt/oo/interfaces/zif_near/source/main"), "INTERFACE zif_near.");
  assert.equal(host.calls.some(c => c.includes("Z_AAA")), false, "Z_AAA, before Z_APP in the alphabet, was not walked");
});

test("the transpiler's dictionary reads are answered from the extension's DDIC sources", async () => {
  const root = tree();
  root.A4H["System Library"].Z_APP.Dictionary = { "Database Tables": { ZLOG_PIPELINE: { "zlog_pipeline.tabl.json": "{}",
    "zlog_pipeline.tabl.ddic": "@AbapCatalog.tableCategory : #TRANSPARENT\ndefine table zlog_pipeline {\n  key mandt : mandt not null;\n  key step_no : abap.numc(3) not null;\n  modifier_class : abap.char(30) not null;\n}" } } };
  const repo = createExtensionRepository({ system, host: fakeHost(root) });
  const objects = await require("../sap-ddic").readDictionary(repo.api ? repo.api.dictionaryQuery : repo.dictionaryQuery, new Set(["ZLOG_PIPELINE", "ZNOWHERE"]), require("../sap-ddic").coreNames());
  const table = objects.find(o => o.name === "ZLOG_PIPELINE");
  assert.equal(table.tabclass, "TRANSP");
  assert.deepEqual(table.fields.map(f => [f.FIELDNAME, f.KEYFLAG, f.ROLLNAME, f.DATATYPE, f.LENG]),
    [["MANDT", "X", "MANDT", "", "0"], ["STEP_NO", "X", "", "NUMC", "3"], ["MODIFIER_CLASS", "", "", "CHAR", "30"]]);
  assert.equal(objects.some(o => o.name === "ZNOWHERE"), false, "a name no package has is left to the transpiler");
});

test("the whole system is indexed once, in parallel, kept; a cancelled walk is not kept", async () => {
  let kept = null;
  const store = { load: () => kept, save: value => { kept = JSON.parse(JSON.stringify(value)); } };
  const seen = [];
  const index = createIndex({ fs: fakeHost(), destination: "A4H", store });
  const done = await index.walkAll({ workers: 3, onProgress: (walked, known) => seen.push([walked, known]) });
  assert.equal(done.cancelled, false);
  assert.equal(kept.objects.filter(o => !o.type.startsWith("DDIC")).length, 6);
  assert.ok(seen.length >= 3 && seen.every(([w, k]) => w <= k));
  kept = null;
  let calls = 0;
  const stopped = await createIndex({ fs: fakeHost(), destination: "A4H", store }).walkAll({ workers: 1, cancelled: () => ++calls > 2 });
  assert.equal(stopped.cancelled, true);
  assert.equal(kept, null, "a cancelled walk is not kept");
});

test("while the system is indexed, a lookup takes what is collected and says the index is being built", async () => {
  const host = fakeHost();
  const slow = { ...host, readDirectory: async segments => { await new Promise(r => setTimeout(r, 5)); return host.readDirectory(segments); } };
  const repo = createExtensionRepository({ system: { ...system, packages: [] }, host: slow });
  const walking = repo.indexAll({ workers: 1 });
  await new Promise(r => setTimeout(r, 1));
  await assert.rejects(repo.execute("read_sap_object", { object_type: "CLAS", object_name: "ZCL_APP" }), /being built/);
  await walking;
  assert.equal((await repo.execute("read_sap_object", { object_type: "CLAS", object_name: "ZCL_APP" })).package, "Z_APP");
});

test("a package whose name has a hyphen is a package, and its objects are indexed", async () => {
  const root = tree();
  root.A4H["System Library"].Z_APP["ZAPP-EXITS-MM"] = { "Source Code Library": { Includes: { ZXVBZU01: { "zxvbzu01.prog.abap": "* exit" } } } };
  const index = await buildIndex(fakeHost(root), "A4H");
  assert.equal(index.objects.get("INCL:ZXVBZU01").package, "ZAPP-EXITS-MM");
});
