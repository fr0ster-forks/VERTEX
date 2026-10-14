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
  // An inline declaration's target is the field it declares: DATA(lv_x) writes LV_X.
  const targets = node.findAllExpressionsRecursive(lint.Expressions.Target).map(item => {
    const inline = item.findFirstExpression(lint.Expressions.InlineData);
    const field = inline && inline.findFirstExpression(lint.Expressions.TargetField);
    return upper((field || item).concatTokens());
  });
  const written = new Set(targets);
  const reads = [];
  for (const chain of node.findAllExpressionsRecursive(lint.Expressions.FieldChain)) {
    const name = upper(chain.concatTokens());
    if (!written.has(name) && !reads.includes(name)) reads.push(name);
  }
  // The right-hand side as pieces: text, and the field chains in it, so the expression can put each one's own
  // derivation in its place. A statement with no source - LOOP, WRITE - has none.
  const source = node.findDirectExpression(lint.Expressions.Source);
  const rhs = source ? pieces(source, lint) : null;
  return { text: node.concatTokens(), targets, reads, rhs, line: node.getStart().getRow() };
}
function pieces(expression, lint) {
  const out = [];
  const visit = item => {
    if (item instanceof lint.Nodes.ExpressionNode && item.get() instanceof lint.Expressions.FieldChain) { out.push({ chain: upper(item.concatTokens()) }); return; }
    if (item instanceof lint.Nodes.TokenNode || item instanceof lint.Nodes.TokenNodeRegex) { out.push({ text: item.getFirstToken().getStr() }); return; }
    item.getChildren().forEach(visit);
  };
  visit(expression);
  return out;
}

/* request: { variable, at, steps: [{ url, line, location, values: { NAME: value } }], sources: { url: text } }
   values are the whole set at that stop, before its statement ran. */
function build(request) {
  const steps = Array.isArray(request?.steps) ? request.steps : [];
  const variable = upper(request?.variable);
  if (!variable) throw new Error("Choose a value in Variables first.");
  if (!steps.length) throw new Error("Nothing is recorded yet.");
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
  // A record of steps alone - no values - still says which statements ran: a value is then derived from the last of
  // them that wrote it, and shown without values.
  const hasValues = steps.some(step => step.values && Object.keys(step.values).length);
  const statementOfStep = index => {
    const step = steps[index], statements = step && statementsOf(step.url);
    return statements ? statementAt(statements, step.line) : null;
  };
  const writes = (index, name) => {
    const statement = statementOfStep(index), base = upper(name).split("-")[0];
    return !!statement && statement.targets.some(target => target === upper(name) || target === base || upper(name).startsWith(target + "-"));
  };
  const known = name => hasValues ? steps.some((_, index) => valueAt(name, index) !== undefined)
    : steps.some((_, index) => writes(index, name));
  const nodes = [], edges = [], said = [];
  let count = 0, maxLevel = 0;
  // The last change of a value at or before a stop: the stop whose statement made it, or none - the value came from
  // before the record, or from code the record did not stop in.
  // A change seen on coming back from a call was made by the call: the statement is the last stop at the depth the
  // change is seen at, not the deeper stop just before it.
  const depthOf = index => Number(steps[index]?.depth) || 0;
  const changeOf = (name, upto) => {
    if (!hasValues) {
      for (let index = upto - 1; index >= 0; index--) if (writes(index, name)) return { made: index, seen: index + 1 };
      return null;
    }
    for (let index = upto; index >= 1; index--) {
      if (signature(valueAt(name, index)) === signature(valueAt(name, index - 1))) continue;
      let made = index - 1;
      if (depthOf(made) > depthOf(index)) while (made > 0 && depthOf(made) > depthOf(index)) made--;
      return { made, seen: index };
    }
    return null;
  };
  /* The value a call gave back, as the routine had it. The record is taken before each statement, so the routine's
     last statement never shows its result inside the call: the routine's name for the value is found by the statement
     that last wrote the same component within the call, and is derived from that statement. A value with no component
     is matched by value at the routine's last stop. */
  const returnedBy = (name, seen, made) => {
    const component = upper(name).split("-").slice(1).join("-");
    if (component) {
      let end = made + 1;
      while (end < steps.length && depthOf(end) > depthOf(made)) end++;
      for (let index = end - 1; index > made; index--) {
        if (depthOf(index) !== depthOf(made) + 1) continue;
        const target = (statementOfStep(index)?.targets || []).find(item => item.endsWith("-" + component));
        if (target) return { name: target, made: index };
      }
    }
    if (!hasValues) return null;
    const inside = seen - 1, wanted = signature(valueAt(name, seen)), parts = upper(name).split("-");
    if (wanted === undefined) return null;
    const names = Object.keys(steps[inside]?.values || {}).filter(key => key !== parts[0]);
    const same = names.map(key => component ? key + "-" + component : key)
      .filter(candidate => signature(valueAt(candidate, inside)) === wanted && changeOf(candidate, inside));
    const found = same[0] && changeOf(same[0], inside);
    return found ? { name: same[0], made: found.made } : null;
  };
  // forced: the stop whose statement made the value, and the value it made, when the caller already knows them.
  const derive = (name, upto, level, walked, forced = null) => {
    const id = "rf" + count++;
    const value = valueAt(name, Math.min(upto, steps.length - 1));
    maxLevel = Math.max(maxLevel, level);
    const found = forced ? { made: forced.made, seen: forced.made + 1 } : changeOf(name, Math.min(upto, steps.length - 1));
    // The guard is the name at a stop, not the name: x = x + y reads the x of an earlier stop, which is derived too.
    const change = found && !walked.has(name + "@" + found.made) ? found : null;
    if (!change) {
      const node = { id, level, of: name, value: shown(value), text: name, outside: true, source: "", line: 0, location: "", children: [] };
      return node;
    }
    const made = change.made, step = steps[made];
    const statements = statementsOf(step.url);
    const statement = statements ? statementAt(statements, step.line) : null;
    if (!statements && !said.includes(step.url)) said.push(step.url);
    const node = { id, level, of: name, value: forced ? forced.value : shown(valueAt(name, change.seen)), before: shown(valueAt(name, change.made)),
      text: statement ? statement.text : "line " + step.line, rhs: statement ? statement.rhs : null, source: step.url, line: step.line, location: step.location || "",
      stop: made, children: [] };
    // Set on entering a call: a parameter, given by the call's arguments. In the expression it stays a name.
    if (hasValues && !forced && depthOf(change.seen) > depthOf(made)) { node.parameter = true; node.rhs = null; node.text = "parameter of " + node.text; }
    const path = new Set(walked).add(name + "@" + made);
    // Changed by a call: the value came back from the routine it ran. The record's last stop inside that call holds it
    // under the routine's own name - the same component of its returning structure, else the variable that had it.
    const called = hasValues ? change.seen - 1 > made : depthOf(made + 1) > depthOf(made) && !node.parameter;
    const returned = called ? returnedBy(name, change.seen, made) : null;
    if (returned) { const child = derive(returned.name, returned.made, level + 1, path, { made: returned.made, value: node.value }); child.returned = true; node.children.push(child); }
    for (const read of statement ? statement.reads : []) {
      if (!known(read)) continue;
      node.children.push(derive(read, made, level + 1, path));
    }
    return node;
  };
  const tree = derive(variable, at, 0, new Set());
  const walk = node => {
    nodes.push({ id: node.id, level: node.level, text: node.text, label: hasValues ? node.of + " = " + (node.value === "" ? "(empty)" : node.value) + (node.outside ? "" : "  ·  " + node.text) : node.text,
      dataText: node.text, location: node.location || node.source, source: node.source, line: node.line, stack: 0, variables: [] });
    node.children.forEach(child => { edges.push({ from: node.id, to: child.id, label: child.of }); walk(child); });
  };
  walk(tree);
  return { formula: { nodes, edges, maxLevel }, tree, hasValues, panes: { formula: formulaPane(tree, said, hasValues), expression: expressionPane(tree, hasValues) } };
}

const where = node => node.outside ? "not changed in the record" : (String(node.location || "").split("->")[0] || node.source) + ":" + node.line + " · stop " + (node.stop + 1);
const button = node => node.source ? `<button class="location code-location" title="Open this statement in source; Ctrl+Click opens beside" data-node="${escape(node.id)}" data-source="${escape(node.source)}" data-line="${node.line}">&lt;/&gt;</button>` : "";

function formulaPane(tree, said, hasValues = true) {
  const html = (node, root) => {
    const caption = `<span class="formula-expression"><b>${escape(node.of)}</b>${hasValues ? " = " + escape(node.value) : ""}</span>`
      + (node.outside ? ` <span class="edge">${escape(hasValues ? where(node) : "not written in the record")}</span>` : ` <code>${escape(node.text)}</code> <span class="edge">${escape(where(node))}${hasValues && node.before !== undefined ? " · was " + (node.before === "" ? "empty" : escape(node.before)) : ""}</span>`) + button(node);
    const children = node.children.map(child => html(child, false)).join("");
    return children ? `<details class="formula-node" data-formula-node="${escape(node.id)}" data-level="${node.level}"${root ? " open" : ""}><summary>${caption}</summary><div class="formula-children">${children}</div></details>`
      : `<div class="formula-leaf" data-formula-node="${escape(node.id)}" data-level="${node.level}">${caption}</div>`;
  };
  const missing = said.length ? `<p class="edge">No source for ${escape(said.join(", "))}: its statements are shown by line.</p>` : "";
  return `<p class="edge">From the run - each value, the statement that set it, and what that statement read${hasValues ? ", with the values the record holds" : "; recorded without values (Rec steps)"}</p>${missing}` + html(tree, true);
}

// The derivation written out as one expression, as the analysis's Expression is: the right-hand side of the statement
// that made the value, each value it read replaced by its own right-hand side, as far as the record goes. Under it the
// statements in the order they ran, and the values it started from.
// A name of the formula with the value the record holds for it, in brackets; the view hides the values with
// With values off.
const named = (name, value, hasValues) => escape(name.toLowerCase()) + (hasValues && value !== undefined ? `<span class="rf-value"> (${escape(value === "" ? "empty" : value)})</span>` : "");
const tail = name => upper(name).split("-").slice(1).join("-");
/* The derivation written out as one expression, the one way the run went: the right-hand side of the statement that
   made the value, each value it read replaced by its own right-hand side, as far as the record goes. A value a call
   changed is written as the routine computed it - the child that carries the same component (LS_RESULT-AMOUNT,
   then the routine's CS_CONTEXT-AMOUNT), or the value it returned. HTML, with the values of the names left in it. */
function expressionText(node, hasValues, seen = new Set()) {
  if (node.outside || seen.has(node.id)) return named(node.of, node.value, hasValues);
  const path = new Set(seen).add(node.id);
  const reads = new Set((node.rhs || []).filter(piece => piece.chain).map(piece => piece.chain));
  const carrier = node.children.find(item => item.returned && !item.outside)
    || (tail(node.of) && node.children.find(item => !item.outside && !reads.has(item.of) && tail(item.of) === tail(node.of)));
  if (carrier) return expressionText(carrier, hasValues, path);
  if (!node.rhs) return named(node.of, node.value, hasValues);
  return node.rhs.map(piece => {
    if (!piece.chain) return escape(piece.text);
    const child = node.children.find(item => item.of === piece.chain);
    if (!child || child.outside || !child.rhs) return named(piece.chain, child && child.value, hasValues);
    const inner = expressionText(child, hasValues, path);
    return child.rhs.length === 1 ? inner : "( " + inner + " )";
  }).join(" ");
}
// The formula first, then what its names stand for, then the statements in the order they ran.
function expressionPane(tree, hasValues = true) {
  const changes = [];
  const collect = node => { if (!node.outside && !changes.some(item => item.stop === node.stop && item.of === node.of)) changes.push(node); node.children.forEach(collect); };
  collect(tree);
  changes.sort((a, b) => a.stop - b.stop);
  const inputs = [];
  const leaves = node => { if (node.outside && !inputs.some(item => item.of === node.of)) inputs.push(node); node.children.forEach(leaves); };
  leaves(tree);
  if (tree.outside) return `<p class="edge">${escape(tree.of)} was not ${hasValues ? "changed" : "written"} in the record.</p>`;
  const steps = changes.map(node => `<li><code>${escape(node.of.toLowerCase())} = ${node.rhs ? expressionText({ ...node, children: [] }, false) : escape(node.text)}</code> <span class="edge">${hasValues ? "= " + escape(node.value) + " · " : ""}${escape(where(node))}</span>${button(node)}</li>`).join("");
  const given = inputs.map(node => hasValues ? `<li><code>${escape(node.of.toLowerCase())} = ${escape(node.value === "" ? "(empty)" : node.value)}</code> <span class="edge">${escape(where(node))}</span></li>`
    : `<li><code>${escape(node.of.toLowerCase())}</code> <span class="edge">not written in the record</span></li>`).join("");
  return `<p><code>${escape(tree.of.toLowerCase())} = ${expressionText(tree, hasValues)}</code></p>${hasValues ? `<p class="edge">= ${escape(tree.value)}</p>` : ""}`
    + (given ? `<p class="edge">Where the values come from</p><ul class="expression-where">${given}</ul>` : "")
    + (steps ? `<p class="edge">The statements, in the order they ran</p><ol class="expression-steps">${steps}</ol>` : "");
}

module.exports = { build, statementAt, parsedSource };
