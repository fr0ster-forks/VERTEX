"use strict";
/* The dictionary of a system reached through SAP's ADT extension, for the transpiler's run (sap-ddic.js).

   Over HTTP sap-ddic.js reads DD02L, DD03L, DD04L, DD40L and DD01L through ADT's data preview. The extension has no data
   preview, but it shows a customer table or structure as its DDIC source, <name>.tabl.ddic:
     define table zlog_pipeline { key mandt : mandt not null; key step_no : abap.numc(3) not null; include zinc; ... }
   That source is read here, by its tokens, into the rows sap-ddic.js asks for, so that module stays as it is. Standard types
   come from open-abap-core as before; a name the customer packages do not have is answered with no row, and sap-ddic.js says
   which name is missing and who uses it. */
const { tokenize } = require("./value-origin-tokens");

const up = value => String(value || "").toUpperCase();
// The built-in types of a DDIC source, as DD03L names them, with the length a type without one has.
const BUILT_IN = { CHAR: ["CHAR"], NUMC: ["NUMC"], DEC: ["DEC"], CURR: ["CURR"], QUAN: ["QUAN"], RAW: ["RAW"], LCHR: ["LCHR"],
  INT1: ["INT1", 3], INT2: ["INT2", 5], INT4: ["INT4", 10], INT8: ["INT8", 19], FLTP: ["FLTP", 16], DATS: ["DATS", 8], TIMS: ["TIMS", 6],
  DATN: ["DATN", 8], TIMN: ["TIMN", 6], CLNT: ["CLNT", 3], LANG: ["LANG", 1], CUKY: ["CUKY", 5], UNIT: ["UNIT", 3],
  STRING: ["STRG", 0], RAWSTRING: ["RSTR", 0], D16N: ["D16N", 16], D34N: ["D34N", 34], UTCLONG: ["UTCL", 27], ACCP: ["ACCP", 6], PREC: ["PREC", 2] };

/* A table's or structure's DDIC source as its fields: { name, kind, fields: [{ name, key, rollname | datatype+leng+decimals,
   notnull, include }] }. A construct not known here is refused by name, never skipped. */
function parseTableSource(text, file = "") {
  const tokens = tokenize(text), at = i => up(tokens[i] && tokens[i].value), sym = i => tokens[i] && tokens[i].kind === "symbol" ? tokens[i].value : "";
  let i = tokens.findIndex((t, n) => up(t.value) === "DEFINE" && ["TABLE", "STRUCTURE"].includes(at(n + 1)));
  if (i < 0) throw new Error(file + " has no DEFINE TABLE or DEFINE STRUCTURE.");
  const kind = at(i + 1) === "TABLE" ? "table" : "structure", name = at(i + 2);
  i += 3;
  if (sym(i) !== "{") throw new Error(file + ": { expected after " + name + ".");
  i++;
  const fields = [];
  while (i < tokens.length && sym(i) !== "}") {
    // Annotations of a field (@Semantics..., @AbapCatalog...) stand before it; they carry nothing the run needs.
    if (sym(i) === "@") { while (i < tokens.length && sym(i) !== ":") i++; i++; if (sym(i) === "#") i++; i++; continue; }
    const end = (() => { let j = i; while (j < tokens.length && sym(j) !== ";" && sym(j) !== "}") j++; return j; })();
    const part = tokens.slice(i, end), word = n => up(part[n] && part[n].value), symAt = n => part[n] && part[n].kind === "symbol" ? part[n].value : "";
    if (word(0) === "INCLUDE") fields.push({ name: ".INCLUDE", include: word(1) });
    else {
      let n = 0, key = false;
      if (word(0) === "KEY") { key = true; n = 1; }
      const fieldName = word(n);
      if (symAt(n + 1) !== ":") throw new Error(file + ": field " + fieldName + " has no type.");
      const field = { name: fieldName, key, notnull: part.slice(n + 2).some((t, k, all) => up(t.value) === "NOT" && up(all[k + 1] && all[k + 1].value) === "NULL") };
      if (word(n + 2) === "ABAP" && symAt(n + 3) === ".") {
        const type = word(n + 4), known = BUILT_IN[type];
        if (!known) throw new Error(file + ": field " + fieldName + " has the built-in type abap." + type.toLowerCase() + ", which is not read yet.");
        const args = symAt(n + 5) === "(" ? part.slice(n + 6).filter(t => t.kind === "number").map(t => Number(t.value)) : [];
        Object.assign(field, { datatype: known[0], leng: args.length ? args[0] : known[1] || 0, decimals: args[1] || 0 });
      } else field.rollname = word(n + 2);
      fields.push(field);
    }
    i = end + 1;
  }
  return { name, kind, fields };
}

/* The rows of DD02L and DD03L for the tables of `names` found by find(name) -> { text } | null; DD04L, DD40L and DD01L
   only when the customer packages hold no such object - an object of that kind found there is refused by name, as its
   source is not read yet. */
function createDictionaryQuery(find) {
  const parsed = new Map();
  const tableOf = async name => {
    if (!parsed.has(name)) parsed.set(name, find(name, "TABL").then(hit => hit ? parseTableSource(hit.text, hit.file) : null));
    return parsed.get(name);
  };
  return async function query(sql) {
    const m = /FROM\s+(dd0[1-4]l|dd40l)\s+WHERE\s+\w+\s+IN\s*\(([^)]*)\)/i.exec(sql);
    if (!m) throw new Error("The dictionary through SAP ADT extension answers only VERTEX's own dictionary reads, not: " + sql);
    const table = m[1].toLowerCase(), names = m[2].split(",").map(s => s.trim().replace(/^'|'$/g, "").replace(/''/g, "'")).filter(Boolean).map(up);
    const values = [];
    if (table === "dd02l") {
      for (const name of names) { const t = await tableOf(name); if (t) values.push({ TABNAME: t.name, TABCLASS: t.kind === "table" ? "TRANSP" : "INTTAB" }); }
    } else if (table === "dd03l") {
      for (const name of names) {
        const t = await tableOf(name);
        if (!t) continue;
        t.fields.forEach((f, k) => values.push(f.include
          ? { TABNAME: t.name, FIELDNAME: ".INCLUDE", POSITION: String(k + 1), KEYFLAG: "", ROLLNAME: "", COMPTYPE: "S", PRECFIELD: f.include, DATATYPE: "STRU", LENG: "0", DECIMALS: "0", REFTYPE: "", NOTNULL: "" }
          : { TABNAME: t.name, FIELDNAME: f.name, POSITION: String(k + 1), KEYFLAG: f.key ? "X" : "", ROLLNAME: f.rollname || "",
              COMPTYPE: f.rollname ? "E" : "", PRECFIELD: "", DATATYPE: f.datatype || "", LENG: String(f.leng || 0), DECIMALS: String(f.decimals || 0),
              REFTYPE: "", NOTNULL: f.notnull ? "X" : "" }));
      }
    } else {
      const kind = { dd04l: "DTEL", dd40l: "TTYP", dd01l: "DOMA" }[table];
      for (const name of names) {
        if (await find(name, kind)) throw new Error("Reading the " + { DTEL: "data element", TTYP: "table type", DOMA: "domain" }[kind] + " " + name
          + " through SAP ADT extension is not available yet: only tables and structures are read from its dictionary.");
      }
    }
    return { values };
  };
}

module.exports = { parseTableSource, createDictionaryQuery, BUILT_IN };
