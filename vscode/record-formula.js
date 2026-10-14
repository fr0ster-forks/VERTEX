"use strict";
/* Formula and Expression of a value from a recorded run, not from the analysis. The record holds the values at every stop,
   taken before the statement there ran; so where a value differs from the stop before, the statement of that earlier stop
   is the one that changed it. That statement is read with abaplint: what it writes is its target, what it reads are the
   field chains of its sources, and each of those is derived the same way, back through the record. The result has the
   shape of the analysis's formula - nodes and edges for the diagram, a tree for the panes - so the view draws either. */

const { escape } = require("./value-origin-formula-html");

const upper = value => String(value || "").toUpperCase();
const signature = value => value === undefined ? undefined : JSON.stringify(value);
const shown = value => value === undefined ? "" : value !== null && typeof value === "object"
  ? (Array.isArray(value) ? value.length + " rows" : JSON.stringify(value)) : String(value);

// The statements of one source, by abaplint; a source that cannot be parsed has none, and says so.
function parsedSource(text, url) {
  const lint = require("@abaplint/core");
  const kind = /\.clas\.abap$|\/oo\/classes\//i.test(url) ? "clas" : /\.intf\.abap$|\/oo\/interfaces\//i.test(url) ? "intf" : "prog";
  const registry = new lint.Registry().addFile(new lint.MemoryFile("vertex." + kind + ".abap", String(text || "")));
  registry.parse();
  const file = registry.getFirstObject()?.getABAPFiles()[0];
  return file ? file.getStatements() : [];
}

// What a statement writes and what it reads, from abaplint's expressions: a target and the field chains of its sources.
function statementAt(statements, line) {
  const lint = require("@abaplint/core");
  const covering = statements.filter(node => node.getStart().getRow() <= line && node.getEnd().getRow() >= line
    && !["Comment", "Empty"].includes(node.get().constructor.name));
  const node = covering.find(item => item.getStart().getRow() === line) || covering[0];
  if (!node) return null;
  const targets = node.findAllExpressionsRecursive(lint.Expressions.Target).map(item => upper(item.concatTokens()));
  const written = new Set(targets);
  const reads = [];
  for (const chain of node.findAllExpressionsRecursive(lint.Expressions.FieldChain)) {
    const name = upper(chain.concatTokens());
    if (!written.has(name) && !reads.includes(name)) reads.push(name);
  }
  return { text: node.concatTokens(), targets, reads, line: node.getStart().getRow() };
}

/* request: { variable, at, steps: [{ url, line, location, values: { NAME: value } }], sources: { url: text } }
   values are the whole set at that stop, before its statement ran. */
function build(request) {
  const steps = Array.isArray(request?.steps) ? request.steps : [];
  const variable = upper(request?.variable);
  if (!variable) throw new Error("Choose a value in Variables first.");
  if (!steps.length) throw new Error("The record has no values: record the run with Steps & values.");
  const at = Math.min(steps.length - 1, Number.isInteger(request.at) ? request.at : steps.length - 1);
  const parsed = new Map();
  const statementsOf = url => {
    if (!parsed.has(url)) parsed.set(url, request.sources && request.sources[url] != null ? parsedSource(request.sources[url], url) : null);
    return parsed.get(url);
  };
  // A name may be a component: LS_RESULT-AMOUNT is AMOUNT of LS_RESULT, read from the structure the record kept.
  const valueAt = (name, index) => {
    const values = steps[index]?.values || {};
    const parts = upper(name).split("-");
    let value = values[parts[0]];
    for (const part of parts.slice(1)) {
      if (value === null || typeof value !== "object") return undefined;
      const key = Object.keys(value).find(item => upper(item) === part);
      value = key === undefined ? undefined : value[key];
    }
    return value;
  };
  const known = name => steps.some((_, index) => valueAt(name, index) !== undefined);
  const nodes = [], edges = [], said = [];
  let count = 0, maxLevel = 0;
  // The last change of a value at or before a stop: the stop whose statement made it, or none - the value came from
  // before the record, or from code the record did not stop in.
  const changeOf = (name, upto) => {
    for (let index = upto; index >= 1; index--) {
      if (signature(valueAt(name, index)) !== signature(valueAt(name, index - 1))) return index - 1;
    }
    return -1;
  };
  const derive = (name, upto, level, walked) => {
    const id = "rf" + count++;
    const value = valueAt(name, Math.min(upto + 1, steps.length - 1));
    maxLevel = Math.max(maxLevel, level);
    const made = walked.has(name) ? -1 : changeOf(name, Math.min(upto + 1, steps.length - 1));
    if (made < 0) {
      const node = { id, level, of: name, value: shown(value), text: name, outside: true, source: "", line: 0, location: "", children: [] };
      return node;
    }
    const step = steps[made];
    const statements = statementsOf(step.url);
    const statement = statements ? statementAt(statements, step.line) : null;
    if (!statements && !said.includes(step.url)) said.push(step.url);
    const node = { id, level, of: name, value: shown(valueAt(name, made + 1)), before: shown(valueAt(name, made)),
      text: statement ? statement.text : "line " + step.line, source: step.url, line: step.line, location: step.location || "",
      stop: made, children: [] };
    const path = new Set(walked).add(name);
    for (const read of statement ? statement.reads : []) {
      if (!known(read)) continue;
      node.children.push(derive(read, made, level + 1, path));
    }
    return node;
  };
  const tree = derive(variable, at - 1, 0, new Set());
  const walk = node => {
    nodes.push({ id: node.id, level: node.level, text: node.text, label: node.of + " = " + (node.value === "" ? "(empty)" : node.value) + (node.outside ? "" : "  ·  " + node.text),
      dataText: node.text, location: node.location || node.source, source: node.source, line: node.line, stack: 0, variables: [] });
    node.children.forEach(child => { edges.push({ from: node.id, to: child.id, label: child.of }); walk(child); });
  };
  walk(tree);
  return { formula: { nodes, edges, maxLevel }, tree, panes: { formula: formulaPane(tree, said), expression: expressionPane(tree) } };
}

const where = node => node.outside ? "not changed in the record" : (String(node.location || "").split("->")[0] || node.source) + ":" + node.line + " · stop " + (node.stop + 1);
const button = node => node.source ? `<button class="location code-location" title="Open this statement in source; Ctrl+Click opens beside" data-node="${escape(node.id)}" data-source="${escape(node.source)}" data-line="${node.line}">&lt;/&gt;</button>` : "";

function formulaPane(tree, said) {
  const html = (node, root) => {
    const caption = `<span class="formula-expression"><b>${escape(node.of)}</b> = ${escape(node.value)}</span>`
      + (node.outside ? ` <span class="edge">${escape(where(node))}</span>` : ` <code>${escape(node.text)}</code> <span class="edge">${escape(where(node))}${node.before !== undefined ? " · was " + (node.before === "" ? "empty" : escape(node.before)) : ""}</span>`) + button(node);
    const children = node.children.map(child => html(child, false)).join("");
    return children ? `<details class="formula-node" data-formula-node="${escape(node.id)}" data-level="${node.level}"${root ? " open" : ""}><summary>${caption}</summary><div class="formula-children">${children}</div></details>`
      : `<div class="formula-leaf" data-formula-node="${escape(node.id)}" data-level="${node.level}">${caption}</div>`;
  };
  const missing = said.length ? `<p class="edge">No source for ${escape(said.join(", "))}: its statements are shown by line.</p>` : "";
  return `<p class="edge">From the run - each value, the statement that set it, and what that statement read, with the values the record holds</p>${missing}` + html(tree, true);
}

// The changes in the order they ran: the derivation written out as the run made it.
function expressionPane(tree) {
  const changes = [];
  const collect = node => { if (!node.outside && !changes.some(item => item.stop === node.stop && item.of === node.of)) changes.push(node); node.children.forEach(collect); };
  collect(tree);
  changes.sort((a, b) => a.stop - b.stop);
  const inputs = [];
  const leaves = node => { if (node.outside && !inputs.some(item => item.of === node.of)) inputs.push(node); node.children.forEach(leaves); };
  leaves(tree);
  const steps = changes.map(node => `<li><code>${escape(node.text)}</code> <span class="edge">→ ${escape(node.of)} = ${escape(node.value)} · ${escape(where(node))}</span>${button(node)}</li>`).join("");
  const given = inputs.map(node => `<li><code>${escape(node.of)} = ${escape(node.value)}</code> <span class="edge">${escape(where(node))}</span></li>`).join("");
  return `<p class="edge">From the run - the statements that made ${escape(tree.of)}, in the order they ran</p>`
    + (steps ? `<ol class="expression-steps">${steps}</ol>` : `<p class="edge">${escape(tree.of)} was not changed in the record.</p>`)
    + (given ? `<p class="edge">Values it started from</p><ul class="expression-where">${given}</ul>` : "");
}

module.exports = { build, statementAt, parsedSource };
