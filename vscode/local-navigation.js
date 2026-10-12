"use strict";

const local = require("./local-analysis");
const upper = value => String(value || "").toUpperCase();

function anchor(document, position) {
  const line = document.getText().split(/\r?\n/)[position.line] || "";
  let from = Math.min(position.character, line.length), to = from;
  while (from > 0 && /[\w/]/.test(line[from - 1])) { from--; }
  while (to < line.length && /[\w/]/.test(line[to])) { to++; }
  return from === to ? null : { line, from, to, word: upper(line.slice(from, to)) };
}

function findLine(document, expression) {
  return document.getText().split(/\r?\n/).findIndex(line => expression.test(line));
}

function destination(vscode, document, line, word) {
  if (line < 0) { return null; }
  const text = document.getText().split(/\r?\n/)[line] || "";
  const column = Math.max(0, upper(text).indexOf(upper(word)));
  const range = new vscode.Range(line, column, line, column + word.length);
  return { document, target: new vscode.Location(document.uri, range) };
}

async function resolve(vscode, document, position) {
  const current = local.sourceObject(document), at = anchor(document, position);
  if (!current || !at) { return null; }
  const escaped = at.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = at.line.slice(0, at.from), suffix = at.line.slice(at.to);
  const method = /(?:->|=>)\s*$/.test(prefix) || /^\s*(?:CLASS-)?METHODS?\s*:?(?:\s|$)/i.test(prefix)
    || /^\s*METHOD\s*$/i.test(prefix);
  const perform = /\bPERFORM\s+$/i.test(prefix);
  if (perform) return destination(vscode, document, findLine(document, new RegExp("^\\s*FORM\\s+" + escaped + "\\b", "i")), at.word);
  if (method) {
    let target = document;
    const receiver = /(?:NEW\s+([\w/]+)\s*\([^)]*\)|([\w/]+))\s*(?:->|=>)\s*$/i.exec(prefix);
    const owner = receiver && upper(receiver[1] || (/=>\s*$/.test(prefix) ? receiver[2] : ""));
    if (owner && owner !== current.object_name) {
      try { target = await local.create(vscode, document, current).find(owner, "CLAS"); }
      catch (_) { return null; }
    }
    const implementation = findLine(target, new RegExp("^\\s*METHOD\\s+" + escaped + "\\b", "i"));
    const declaration = findLine(target, new RegExp("^\\s*(?:CLASS-)?METHODS\\s+:?\\s*" + escaped + "\\b", "i"));
    const line = /^\s*METHOD\s*$/i.test(prefix) ? declaration : implementation >= 0 ? implementation : declaration;
    if (target === document && line === position.line) return null;
    return destination(vscode, target, line, at.word);
  }
  const classContext = /\b(?:NEW|CLASS|INTERFACE|TO|TYPE)\s+$/i.test(prefix) || /^\s*=>/.test(suffix);
  if (classContext) {
    const target = at.word === current.object_name ? document
      : await local.create(vscode, document, current).find(at.word, "CLAS").catch(() => null);
    if (target) return destination(vscode, target,
      findLine(target, new RegExp("^\\s*CLASS\\s+" + escaped + "\\s+DEFINITION\\b", "i")), at.word);
  }
  return null;
}

function register(vscode, context) {
  if (!vscode.languages?.registerDefinitionProvider) { return; }
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [{ scheme: "file", language: "abap" }, { scheme: "untitled", language: "abap" }],
    { provideDefinition: async (document, position) => (await resolve(vscode, document, position))?.target }));
}

module.exports = { resolve, register };
