"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { dictionaryNames, readDictionary, objectXml, coreNames } = require("../sap-ddic");
const { writeProject } = require("../sap-transpile");
const { launch } = require("../local-run");

const field = (table, name, position, rollname, comptype, datatype, leng, decimals = 0, extra = {}) => ({ TABNAME: table,
  FIELDNAME: name, POSITION: String(position).padStart(4, "0"), KEYFLAG: position === 1 ? "X" : "", ROLLNAME: rollname,
  COMPTYPE: comptype, PRECFIELD: "", DATATYPE: datatype, LENG: String(leng).padStart(6, "0"),
  DECIMALS: String(decimals).padStart(6, "0"), REFTYPE: "", NOTNULL: "", ...extra });
// A dictionary as SAP's DD tables hold it: a table with an include, a structure, a data element named as its domain.
const dictionary = {
  DD02L: [{ TABNAME: "ZSHIP", TABCLASS: "TRANSP" }, { TABNAME: "ZSHIP_INC", TABCLASS: "INTTAB" }],
  DD03L: [field("ZSHIP", "ID", 1, "ZCHAR7", "E", "CHAR", 7), field("ZSHIP", "WEIGHT", 2, "", "", "DEC", 17, 3),
    field("ZSHIP", ".INCLUDE", 3, "", "", "", 0, 0, { PRECFIELD: "ZSHIP_INC" }),
    field("ZSHIP_INC", "COUNTRY", 1, "ZLAND", "E", "CHAR", 3)],
  DD04L: [{ ROLLNAME: "ZCHAR7", DOMNAME: "ZCHAR7", DATATYPE: "CHAR", LENG: "000007", DECIMALS: "000000", REFKIND: "D", REFTYPE: "" },
    { ROLLNAME: "ZLAND", DOMNAME: "ZLAND_D", DATATYPE: "CHAR", LENG: "000003", DECIMALS: "000000", REFKIND: "D", REFTYPE: "" }],
  DD40L: [{ TYPENAME: "ZSHIP_TT", ROWTYPE: "ZSHIP", ROWKIND: "S", DATATYPE: "", LENG: "000000", DECIMALS: "000000", ACCESSMODE: "T", KEYDEF: "D" }],
  DD01L: [{ DOMNAME: "ZCHAR7", DATATYPE: "CHAR", LENG: "000007", DECIMALS: "000000" },
    { DOMNAME: "ZLAND_D", DATATYPE: "CHAR", LENG: "000003", DECIMALS: "000000" }]
};
const queryOf = rows => {
  const asked = [];
  const query = async sql => {
    const found = /FROM (\w+) WHERE (\w+) IN \(([^)]*)\) AND as4local = 'A'/i.exec(sql);
    assert.ok(found, sql);
    const names = found[3].split(",").map(name => name.trim().replace(/'/g, ""));
    asked.push(found[1].toUpperCase() + ":" + names.join(","));
    return { values: (rows[found[1].toUpperCase()] || []).filter(row => names.includes(row[found[2].toUpperCase()])) };
  };
  return { query, asked };
};

test("names a source takes from the dictionary", () => {
  const names = dictionaryNames("DATA a TYPE zship.\nDATA t TYPE STANDARD TABLE OF zrow WITH EMPTY KEY.\nDATA r TYPE REF TO zcl_x.\n" +
    "DATA c TYPE char12.\nDATA f TYPE zs-field.\nSELECT * FROM ztab INNER JOIN zj ON a = b INTO TABLE @t.\n" +
    "DATA x TYPE zcl_y=>ty.\nDATA i TYPE i.\nTYPES ty TYPE RANGE OF zr.\nTYPES BEGIN OF s.\nINCLUDE STRUCTURE zinc.\nTYPES END OF s.\n");
  assert.deepEqual([...names].sort(), ["CHAR12", "ZCL_X", "ZINC", "ZJ", "ZR", "ZROW", "ZS", "ZSHIP", "ZTAB"]);
});

test("reads the closure: an include, a table type, data elements and domains of the same name", async () => {
  const { query, asked } = queryOf(dictionary);
  const objects = await readDictionary(query, new Set(["ZSHIP_TT", "TY_LOCAL"]), new Set(["MANDT"]));
  assert.deepEqual(objects.map(o => o.kind + " " + o.name).sort(),
    ["DOMA ZCHAR7", "DOMA ZLAND_D", "DTEL ZCHAR7", "DTEL ZLAND", "TABL ZSHIP", "TABL ZSHIP_INC", "TTYP ZSHIP_TT"]);
  assert.ok(asked.some(line => line.startsWith("DD01L:") && line.includes("ZCHAR7")), "the domain named as its data element is read");
});

test("a definition's missing dependency stops the run; a source's unknown name does not", async () => {
  const broken = { ...dictionary, DD04L: dictionary.DD04L.filter(row => row.ROLLNAME !== "ZLAND") };
  await assert.rejects(readDictionary(queryOf(broken).query, new Set(["ZSHIP"])), /The dictionary has no ZLAND \(used by ZSHIP_INC\)/);
  assert.deepEqual(await readDictionary(queryOf(dictionary).query, new Set(["TY_LOCAL"])), []);
});

test("abapGit XML of the objects", async () => {
  const objects = await readDictionary(queryOf(dictionary).query, new Set(["ZSHIP_TT"]));
  const table = objectXml(objects.find(o => o.name === "ZSHIP"));
  assert.equal(table.file, "zship.tabl.xml");
  assert.match(table.xml, /<DD02V><TABNAME>ZSHIP<\/TABNAME><TABCLASS>TRANSP<\/TABCLASS><\/DD02V>/);
  assert.match(table.xml, /<DD03P><FIELDNAME>.INCLUDE<\/FIELDNAME><PRECFIELD>ZSHIP_INC<\/PRECFIELD><\/DD03P>/);
  assert.match(table.xml, /<FIELDNAME>WEIGHT<\/FIELDNAME><DATATYPE>DEC<\/DATATYPE><LENG>000017<\/LENG><DECIMALS>000003<\/DECIMALS>/);
  assert.equal(objectXml(objects.find(o => o.kind === "DOMA" && o.name === "ZCHAR7")).file, "zchar7.doma.xml");
  assert.ok(coreNames().has("MANDT"));
});

test("a program typed by the dictionary transpiles and runs", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-sap-ddic-"));
  try {
    const objects = await readDictionary(queryOf(dictionary).query, new Set(["ZSHIP_TT"]));
    const file = writeProject("TEST", [{ name: "ZDDIC", type: "PROG", include: "main", text: "REPORT zddic.\n" +
      "DATA lt TYPE zship_tt.\nDATA ls TYPE zship.\nls-id = 'ABCDEFGHIJ'.\nls-country = 'DEU'.\nls-weight = '1.5'.\n" +
      "APPEND ls TO lt.\nWRITE: / ls-id, ls-country, lines( lt ).\n" }], objects, folder);
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8") };
    let log = "";
    const vscode = { workspace: { getWorkspaceFolder: () => undefined },
      window: { createOutputChannel: () => ({ append: t => { log += t; }, appendLine: t => { log += t + "\n"; }, hide() {}, show() {} }) } };
    const result = await launch(vscode, false, { document, selection: {}, trace: true })
      .catch(error => { throw new Error(error.message + "\n" + log); });
    // ID is CHAR 7 by its data element and domain, so the value is cut as SAP cuts it.
    assert.match(result.output, /^ABCDEFG\s*DEU\s*1\b/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
