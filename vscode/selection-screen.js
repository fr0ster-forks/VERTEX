"use strict";
/* A program's selection screen 1000 as the panel draws it, read from the program's statements - tokens, a chain
   (PARAMETERS: a ..., b ...) taken apart as ABAP does: PARAMETERS (a value, AS CHECKBOX, RADIOBUTTON GROUP, OBLIGATORY,
   LOWER CASE, NO-DISPLAY), SELECT-OPTIONS (FOR a field, DEFAULT low TO high, OPTION, SIGN, NO INTERVALS, NO-EXTENSION),
   and SELECTION-SCREEN's layout: blocks with their frame and title, comments, SKIP, ULINE, a line of several elements.
   What it cannot draw - a pushbutton, a tabbed block, a function key - is kept as a note naming it, so the reader sees
   that it is left out. Another screen (BEGIN OF SCREEN n) is not screen 1000 and is skipped whole. The model is
   modelled on open-abap-gui's (its converter's collect-selection-screens), built here from tokens, not from text. */
const { tokenize } = require("./value-origin-tokens");

const up = value => String(value || "").toUpperCase();
const NUMERIC = ["I", "INT8", "P", "F", "N", "DECFLOAT16", "DECFLOAT34", "INT1", "INT2", "INT4"];

/* The statements of a text, each chain made into the statements it stands for, with the line each starts on. */
function statements(text) {
  const out = []; let part = [];
  const flush = () => {
    if (!part.length) return;
    const colon = part.findIndex(token => token.value === ":");
    if (colon < 0) { out.push(part); part = []; return; }
    const head = part.slice(0, colon); let piece = [], depth = 0;
    for (const token of part.slice(colon + 1)) {
      if (token.value === "(") depth++;
      if (token.value === ")") depth--;
      if (token.value === "," && depth === 0) { if (piece.length) out.push(head.concat(piece)); piece = []; }
      else piece.push(token);
    }
    if (piece.length) out.push(head.concat(piece));
    part = [];
  };
  // SELECTION-SCREEN, NO-DISPLAY, TEXT-001, SY-DATUM: the tokenizer splits at the hyphen; written without a blank
  // they are one word.
  const merged = [];
  for (const token of tokenize(String(text || ""))) {
    const last = merged[merged.length - 1], before = merged[merged.length - 2];
    if (token.kind !== "literal" && last && last.value === "-" && before && before.kind === "word"
      && before.endOffset === last.offset && last.endOffset === token.offset) {
      merged.pop(); merged[merged.length - 1] = { ...before, value: before.value + "-" + token.value, endOffset: token.endOffset };
      continue;
    }
    merged.push(token);
  }
  for (const token of merged) {
    if (token.kind === "symbol" && token.value === ".") flush(); else part.push(token);
  }
  flush();
  // line: where the element's own name stands; start: where its statement - a whole chain - begins, which is the line
  // the transpiler's map names for every piece of a chain.
  return out.map(tokens => ({ tokens, line: tokens[tokens.length > 1 ? 1 : 0].line, start: tokens[0].line }));
}

const at = (ts, i) => up(ts[i] && ts[i].value);
const find = (ts, value, from = 0) => ts.findIndex((t, i) => i >= from && up(t.value) === value);
const has = (ts, ...words) => { const i = find(ts, words[0]); return i >= 0 && words.every((w, k) => at(ts, i + k) === w); };
/* A literal's value; a name stays as written (a constant, SY-DATUM) and is marked as such. */
function literal(token) {
  if (!token) return { value: "" };
  const text = String(token.value);
  if (/^'.*'$/s.test(text)) return { value: text.slice(1, -1).replace(/''/g, "'") };
  if (/^`.*`$/s.test(text)) return { value: text.slice(1, -1).replace(/``/g, "`") };
  if (token.kind === "number") return { value: text };
  return { value: up(text), name: true };
}
/* What follows a keyword, as written: a literal, or a name with its components (SY-DATUM). */
function after(ts, keyword) {
  const i = find(ts, keyword);
  if (i < 0 || !ts[i + 1]) return null;
  let j = i + 1, token = ts[j];
  if (token.value === "-" && ts[j + 1] && ts[j + 1].kind === "number") return { value: "-" + ts[j + 1].value };
  const value = literal(token);
  while (value.name && ts[j + 1] && ts[j + 1].value === "-" && ts[j + 2] && ts[j + 2].kind === "word") { value.value += "-" + up(ts[j + 2].value); j += 2; }
  return value;
}
/* A text: TEXT-nnn, a literal, or a name (a constant's). */
function textOf(token, next) {
  if (!token) return null;
  if (up(token.value) === "TEXT" && next && next.value === "-") return null;
  const value = String(token.value);
  if (/^TEXT-\w+$/i.test(value)) return { symbol: value.slice(5).toUpperCase() };
  if (/^'.*'$/s.test(value) || /^`.*`$/s.test(value)) return { literal: literal(token).value };
  return { name: up(value) };
}
const textAfter = (ts, keyword) => { const i = find(ts, keyword); return i < 0 ? null : textAt(ts, i + 1); };
// TEXT-001 is three tokens to the tokenizer: TEXT, -, 001.
function textAt(ts, i) {
  if (!ts[i]) return null;
  if (up(ts[i].value) === "TEXT" && ts[i + 1] && ts[i + 1].value === "-" && ts[i + 2]) return { symbol: up(ts[i + 2].value) };
  return textOf(ts[i]);
}

/* The type a field is declared with in the program: DATA name TYPE t, for SELECT-OPTIONS ... FOR name. */
function declaredTypes(list) {
  const types = new Map();
  for (const { tokens: ts } of list) {
    if (!["DATA", "CONSTANTS", "STATICS"].includes(at(ts, 0)) || !ts[1]) continue;
    const type = find(ts, "TYPE");
    if (type > 0 && ts[type + 1]) types.set(up(ts[1].value), at(ts, type + 1));
  }
  return types;
}

function selectionScreen(text) {
  const list = statements(text), types = declaredTypes(list), elements = [];
  let otherScreen = 0;
  for (const { tokens: ts, line, start } of list) {
    const first = at(ts, 0);
    if (first === "SELECTION-SCREEN") {
      if (has(ts, "BEGIN", "OF", "SCREEN")) { otherScreen++; continue; }
      if (has(ts, "END", "OF", "SCREEN")) { otherScreen = Math.max(0, otherScreen - 1); continue; }
      if (otherScreen) continue;
      if (has(ts, "BEGIN", "OF", "TABBED", "BLOCK") || has(ts, "TAB") || find(ts, "PUSHBUTTON") >= 0 || has(ts, "FUNCTION", "KEY")
        || find(ts, "INCLUDE") >= 0) { elements.push({ kind: "note", line, text: ts.map(t => t.value).join(" ") }); continue; }
      if (has(ts, "BEGIN", "OF", "BLOCK")) {
        elements.push({ kind: "block", line, name: at(ts, find(ts, "BLOCK") + 1), frame: has(ts, "WITH", "FRAME"), title: textAfter(ts, "TITLE") });
        continue;
      }
      if (has(ts, "END", "OF", "BLOCK")) { elements.push({ kind: "end-block", line }); continue; }
      if (has(ts, "BEGIN", "OF", "LINE")) { elements.push({ kind: "line", line }); continue; }
      if (has(ts, "END", "OF", "LINE")) { elements.push({ kind: "end-line", line }); continue; }
      if (at(ts, 1) === "SKIP") { elements.push({ kind: "skip", line, lines: Number(ts[2] && ts[2].kind === "number" ? ts[2].value : 1) }); continue; }
      if (at(ts, 1) === "ULINE") { elements.push({ kind: "uline", line }); continue; }
      if (at(ts, 1) === "COMMENT") {
        // COMMENT [/][pos](len) text [FOR FIELD f]: the text is the first token after the position, if any.
        let i = 2;
        while (ts[i] && (ts[i].value === "/" || ts[i].kind === "number" || ts[i].value === "(" || ts[i].value === ")")) i++;
        const forField = find(ts, "FIELD") >= 0 ? at(ts, find(ts, "FIELD") + 1) : "";
        elements.push({ kind: "comment", line, text: textAt(ts, i), for: forField });
        continue;
      }
      elements.push({ kind: "note", line, text: ts.map(t => t.value).join(" ") });
      continue;
    }
    if (otherScreen) continue;
    if (first === "PARAMETERS" || first === "PARAMETER") {
      const name = at(ts, 1);
      if (!name || ts[1].kind !== "word") continue;
      const type = find(ts, "TYPE") >= 0 ? at(ts, find(ts, "TYPE") + 1) : find(ts, "LIKE") >= 0 ? "" : "C";
      const radio = find(ts, "RADIOBUTTON") >= 0 && find(ts, "GROUP") >= 0 ? at(ts, find(ts, "GROUP") + 1) : "";
      const checkbox = find(ts, "CHECKBOX") >= 0;
      const length = find(ts, "LENGTH") >= 0 && at(ts, find(ts, "LENGTH") - 1) !== "VISIBLE" ? Number(ts[find(ts, "LENGTH") + 1].value) : undefined;
      const decimals = find(ts, "DECIMALS") >= 0 ? Number(ts[find(ts, "DECIMALS") + 1].value) : undefined;
      const numeric = NUMERIC.includes(type);
      const lower = has(ts, "LOWER", "CASE");
      const def = after(ts, "DEFAULT");
      elements.push({ kind: "parameter", line, start, name, type, length, decimals, like: find(ts, "LIKE") >= 0 ? at(ts, find(ts, "LIKE") + 1) : "",
        radio, checkbox, obligatory: find(ts, "OBLIGATORY") >= 0, hidden: find(ts, "NO-DISPLAY") >= 0, numeric,
        upper: !checkbox && !radio && !numeric && !lower, default: def ? def.value : "", defaultName: !!(def && def.name) });
      continue;
    }
    if (first === "SELECT-OPTIONS") {
      const name = at(ts, 1), forField = find(ts, "FOR") >= 0 ? at(ts, find(ts, "FOR") + 1) : "";
      if (!name || ts[1].kind !== "word") continue;
      const type = types.get(forField.split("-")[0]) || "";
      const numeric = NUMERIC.includes(type);
      const def = after(ts, "DEFAULT"), to = find(ts, "TO");
      const high = to > find(ts, "DEFAULT") && find(ts, "DEFAULT") >= 0 ? literal(ts[to + 1]) : null;
      const option = find(ts, "OPTION") >= 0 ? at(ts, find(ts, "OPTION") + 1) : high ? "BT" : "EQ";
      const sign = find(ts, "SIGN") >= 0 ? at(ts, find(ts, "SIGN") + 1) : "I";
      elements.push({ kind: "select-option", line, start, name, for: forField, type, numeric,
        upper: !numeric && !has(ts, "LOWER", "CASE"), obligatory: find(ts, "OBLIGATORY") >= 0, hidden: find(ts, "NO-DISPLAY") >= 0,
        noIntervals: has(ts, "NO", "INTERVALS"), noExtension: find(ts, "NO-EXTENSION") >= 0,
        default: def ? { sign, option, low: def.value, high: high ? high.value : "" } : null });
    }
  }
  return { elements };
}

/* abapGit's text pool of a program (TPOOL in its .prog.xml): selection texts by name (ID S, the text after its
   8 leading characters, as abapGit keeps them) and text symbols by key (ID I). */
function textPoolOf(xml) {
  const texts = { selections: {}, symbols: {} };
  for (const item of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = name => { const found = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(item[1]); return found ? found[1] : ""; };
    const id = field("ID"), key = up(field("KEY")), entry = field("ENTRY").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (id === "S" && key) texts.selections[key] = entry.replace(/^.{8}/, "").trim() || entry.trim();
    if (id === "I" && key) texts.symbols[key] = entry;
  }
  return texts;
}
/* ADT's text elements of a program, as it shows them: NAME =text per line for the selections, key=text for the symbols.
   A text SAP marks as unset (?...) is none. */
function adtTexts(selections, symbols) {
  const read = (text, separator) => Object.fromEntries(String(text || "").split(/\r?\n/)
    .map(line => new RegExp("^(\\S+?)\\s*" + separator + "(.*)$").exec(line)).filter(Boolean)
    .filter(found => !/^@/.test(found[1]) && found[2].trim() && found[2].trim() !== "?...")
    .map(found => [up(found[1]), found[2].trim()]));
  return { selections: read(selections, "="), symbols: read(symbols, "=") };
}

module.exports = { statements, selectionScreen, textPoolOf, adtTexts };
