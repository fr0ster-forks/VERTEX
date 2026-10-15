"use strict";
/* The DDIC an SAP program's transpiler run needs, read from the system's dictionary tables over ADT's data preview and
   written as the abapGit XML the transpiler reads: structures and tables (DD02L, DD03L), data elements (DD04L), domains
   (DD01L) and table types (DD40L). The names start from what the sources name after TYPE, INCLUDE TYPE/STRUCTURE, TABLES
   and in a SELECT's FROM or JOIN, and follow what each definition uses until nothing new is named. A name the sources use
   that the dictionary does not have is left to the transpiler, which names what it cannot resolve; a name a definition
   uses that the dictionary does not have stops the run. */
const fs = require("fs");
const path = require("path");
const { tokenize } = require("./value-origin-tokens");

const up = value => String(value || "").toUpperCase();
const BUILT_IN = new Set(["I", "INT8", "F", "P", "C", "N", "D", "T", "X", "STRING", "XSTRING", "DECFLOAT16", "DECFLOAT34",
  "UTCLONG", "ABAP_BOOL", "ANY", "DATA", "SIMPLE", "CLIKE", "CSEQUENCE", "XSEQUENCE", "NUMERIC", "OBJECT", "TABLE", "INDEX",
  "STANDARD", "SORTED", "HASHED", "LINE", "RANGE", "REF", "TO", "OF", "VALUE", "LENGTH", "DECIMALS", "READ-ONLY", "BOXED"]);
const CHUNK = 40;

/* The names a source may take from the dictionary. */
function dictionaryNames(text) {
  const tokens = tokenize(text), names = new Set();
  const at = i => up(tokens[i] && tokens[i].value);
  const name = i => tokens[i] && tokens[i].kind === "word" && at(i + 1) !== "=>" && !BUILT_IN.has(at(i)) ? at(i) : "";
  const add = i => { const found = name(i); if (found) names.add(found); };
  for (let i = 0; i < tokens.length; i++) {
    const current = at(i);
    if (current === "TYPE" || current === "STRUCTURE" && at(i - 1) === "INCLUDE") {
      let j = i + 1;
      if (at(j) === "REF" && at(j + 1) === "TO") j += 2;
      if (at(j) === "LINE" && at(j + 1) === "OF") j += 2;
      else if (at(j) === "RANGE" && at(j + 1) === "OF") j += 2;
      else {
        while (["STANDARD", "SORTED", "HASHED", "ANY", "INDEX"].includes(at(j))) j++;
        if (at(j) === "TABLE" && at(j + 1) === "OF") { j += 2; if (at(j) === "REF" && at(j + 1) === "TO") j += 2; }
      }
      add(j);
    }
    if ((current === "FROM" || current === "JOIN" || current === "TABLES") && tokens[i + 1]) add(i + 1);
  }
  return names;
}

/* The rows of a SELECT over a list of names, in chunks the data preview takes. */
async function selectIn(query, select, column, names) {
  const rows = [];
  for (let at = 0; at < names.length; at += CHUNK) {
    const list = names.slice(at, at + CHUNK).map(name => "'" + name.replace(/'/g, "''") + "'").join(", ");
    const data = await query(select + " WHERE " + column + " IN (" + list + ") AND as4local = 'A'", 100000);
    rows.push(...(data.values || []).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [up(key), value]))));
  }
  return rows;
}

/* The dictionary closure of the names, without those `known` (open-abap-core's, the classes read). A data element and
   its domain often share a name, so types (tables and structures, data elements, table types) and domains are asked for
   apart. */
async function readDictionary(query, start, known = new Set()) {
  const types = new Map(), domains = new Map(), asked = { type: new Set(), domain: new Set() };
  const required = []; // [name, kind, who needs it]
  const pending = { type: [...start].filter(name => !known.has(name)), domain: [] };
  const need = (name, by, kind = "type") => {
    name = up(name);
    if (!name || known.has(name) || BUILT_IN.has(name)) return;
    required.push([name, kind, by]);
    if (!asked[kind].has(name)) pending[kind].push(name);
  };
  while (pending.type.length || pending.domain.length) {
    const names = [...new Set(pending.type)].filter(name => !asked.type.has(name));
    const domainNames = [...new Set(pending.domain)].filter(name => !asked.domain.has(name));
    pending.type = []; pending.domain = [];
    names.forEach(name => asked.type.add(name));
    domainNames.forEach(name => asked.domain.add(name));
    for (const row of await selectIn(query, "SELECT tabname, tabclass FROM dd02l", "tabname", names))
      types.set(up(row.TABNAME), { kind: "TABL", name: up(row.TABNAME), tabclass: row.TABCLASS, fields: [] });
    const tables = names.filter(name => types.has(name));
    for (const row of await selectIn(query, "SELECT tabname, fieldname, position, keyflag, rollname, comptype, precfield, " +
        "datatype, leng, decimals, reftype, notnull FROM dd03l", "tabname", tables)) {
      const table = types.get(up(row.TABNAME));
      table.fields.push(row);
      const field = up(row.FIELDNAME), comptype = up(row.COMPTYPE);
      if (field === ".INCLUDE" || field.startsWith(".INCLU-") || field === ".APPEND") need(row.PRECFIELD, table.name);
      else if (["E", "S", "L"].includes(comptype)) need(row.ROLLNAME, table.name);
      else if (comptype === "R" && ["E", "S", "L"].includes(up(row.REFTYPE))) need(row.ROLLNAME, table.name);
    }
    const rest = names.filter(name => !types.has(name));
    for (const row of await selectIn(query, "SELECT rollname, domname, datatype, leng, decimals, refkind, reftype FROM dd04l", "rollname", rest)) {
      const element = { kind: "DTEL", name: up(row.ROLLNAME), row };
      types.set(element.name, element);
      if (up(row.REFKIND) === "D") need(row.DOMNAME, element.name, "domain");
      else if (up(row.REFKIND) === "R" && ["E", "S", "L"].includes(up(row.REFTYPE))) need(row.DOMNAME, element.name);
    }
    const left = rest.filter(name => !types.has(name));
    for (const row of await selectIn(query, "SELECT typename, rowtype, rowkind, datatype, leng, decimals, accessmode, keydef FROM dd40l", "typename", left)) {
      const type = { kind: "TTYP", name: up(row.TYPENAME), row };
      types.set(type.name, type);
      if (["E", "S", "L"].includes(up(row.ROWKIND))) need(row.ROWTYPE, type.name);
    }
    for (const row of await selectIn(query, "SELECT domname, datatype, leng, decimals FROM dd01l", "domname", domainNames))
      domains.set(up(row.DOMNAME), { kind: "DOMA", name: up(row.DOMNAME), row });
  }
  const missing = required.filter(([name, kind]) => !(kind === "domain" ? domains : types).has(name));
  if (missing.length) throw new Error("The dictionary has no " + [...new Set(missing.map(([name, kind, by]) =>
    (kind === "domain" ? "domain " : "") + name + " (used by " + by + ")"))].join(", ") + ".");
  for (const table of types.values()) if (table.kind === "TABL") table.fields.sort((a, b) => Number(a.POSITION) - Number(b.POSITION));
  return [...types.values(), ...domains.values()];
}

const escape = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tag = (name, value) => value === undefined || value === null || String(value) === "" ? "" : "<" + name + ">" + escape(value) + "</" + name + ">";
const number = value => String(Number(value || 0)).padStart(6, "0");
const wrap = (serializer, body) => `<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="${serializer}" serializer_version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>${body}</asx:values></asx:abap></abapGit>\n`;

/* One object as abapGit's XML, with its file name. */
function objectXml(object) {
  const base = object.name.toLowerCase().replace(/\//g, "#");
  if (object.kind === "TABL") {
    const fields = object.fields.map(field => {
      const name = up(field.FIELDNAME);
      return "<DD03P>" + tag("FIELDNAME", name === ".APPEND" ? ".INCLU--AP" : name) + tag("KEYFLAG", field.KEYFLAG) +
        tag("ROLLNAME", field.ROLLNAME) + tag("PRECFIELD", field.PRECFIELD) + tag("NOTNULL", field.NOTNULL) +
        tag("DATATYPE", field.DATATYPE) + (Number(field.LENG) ? tag("LENG", number(field.LENG)) : "") +
        (field.DECIMALS && Number(field.DECIMALS) ? tag("DECIMALS", number(field.DECIMALS)) : "") +
        tag("COMPTYPE", field.COMPTYPE) + tag("REFTYPE", field.REFTYPE) + "</DD03P>";
    }).join("");
    return { file: base + ".tabl.xml", xml: wrap("LCL_OBJECT_TABL", "<DD02V>" + tag("TABNAME", object.name) +
      tag("TABCLASS", object.tabclass) + "</DD02V><DD03P_TABLE>" + fields + "</DD03P_TABLE>") };
  }
  const row = object.row;
  if (object.kind === "DTEL") return { file: base + ".dtel.xml", xml: wrap("LCL_OBJECT_DTEL", "<DD04V>" + tag("ROLLNAME", object.name) +
    tag("DOMNAME", row.DOMNAME) + tag("DATATYPE", row.DATATYPE) + tag("LENG", number(row.LENG)) +
    (Number(row.DECIMALS) ? tag("DECIMALS", number(row.DECIMALS)) : "") + tag("REFKIND", row.REFKIND) + tag("REFTYPE", row.REFTYPE) + "</DD04V>") };
  if (object.kind === "DOMA") return { file: base + ".doma.xml", xml: wrap("LCL_OBJECT_DOMA", "<DD01V>" + tag("DOMNAME", object.name) +
    tag("DATATYPE", row.DATATYPE) + tag("LENG", number(row.LENG)) + (Number(row.DECIMALS) ? tag("DECIMALS", number(row.DECIMALS)) : "") + "</DD01V>") };
  return { file: base + ".ttyp.xml", xml: wrap("LCL_OBJECT_TTYP", "<DD40V>" + tag("TYPENAME", object.name) + tag("ROWTYPE", row.ROWTYPE) +
    tag("ROWKIND", row.ROWKIND) + tag("DATATYPE", row.DATATYPE) + (Number(row.LENG) ? tag("LENG", number(row.LENG)) : "") +
    (Number(row.DECIMALS) ? tag("DECIMALS", number(row.DECIMALS)) : "") + tag("ACCESSMODE", row.ACCESSMODE) + tag("KEYDEF", row.KEYDEF) + "</DD40V>") };
}

/* The DDIC names the run takes from open-abap-core: the data elements and domains of its ddic folder. */
function coreNames(core = path.join(__dirname, "vendor", "open-abap-core", "src", "ddic")) {
  const names = new Set();
  const visit = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) visit(path.join(dir, item.name));
    else { const found = /^(.+)\.(?:dtel|doma)\.xml$/i.exec(item.name); if (found) names.add(found[1].toUpperCase().replace(/#/g, "/")); }
  } };
  if (fs.existsSync(core)) visit(core);
  return names;
}

module.exports = { dictionaryNames, readDictionary, objectXml, coreNames };
