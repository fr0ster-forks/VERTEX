"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { analyze } = require("./origin-view-fixture");
const { formula } = require("../value-origin-formula");

const expression = (lines, line, variable) => formula(analyze([{ id: "demo", text: lines.join("\n") }], { source: "demo", line, variable })).expression.text;

test("an alternative under IF says when it holds, the one it overrides says otherwise", () => {
  const text = expression(["g = b * r.", "IF g > 1000.", "  g = g - 50.", "ENDIF.", "a = g."], 5, "a");
  assert.match(text, /\(b \* r\) otherwise/);
  assert.match(text, /\(\(b \* r\) - 50\) when g > 1000/);
});

test("an ELSE branch is the condition's negation", () => {
  const text = expression(["IF x > 1.", "  a = 1.", "ELSE.", "  a = 2.", "ENDIF.", "WRITE a."], 6, "a");
  assert.match(text, /1 when x > 1/);
  assert.match(text, /2 when NOT \(x > 1\)/);
});

test("a WHEN branch reads as the CASE value equal to it", () => {
  const text = expression(["CASE k.", "  WHEN 1.", "    a = 10.", "  WHEN 2.", "    a = 20.", "ENDCASE.", "WRITE a."], 7, "a");
  assert.match(text, /10 when k = 1/);
  assert.match(text, /20 when k = 2/);
});

test("a recorded run keeps only the definitions it executed: one calculation, no alternatives", () => {
  const graph = analyze([{ id: "demo", text: ["IF x > 1.", "  a = 1.", "ELSE.", "  a = 2.", "ENDIF.", "WRITE a."].join("\n") }], { source: "demo", line: 6, variable: "a" });
  const ran = new Set([4]);
  const text = formula(graph, definition => ran.has(Number(definition.line))).expression.text;
  assert.doesNotMatch(text, /when|otherwise|\|/);
  assert.match(text, /\b2\b/);
});

test("definitions that all ran are steps in the order the run made them, not alternatives", () => {
  const source = ["a = 10.", "IF x = 1.", "  a = a + 1.", "ENDIF.", "IF y = 1.", "  a = a * 2.", "ENDIF.", "WRITE a."];
  const graph = analyze([{ id: "demo", text: source.join("\n") }], { source: "demo", line: 8, variable: "a" });
  const objectOf = location => String(location || "").toUpperCase().split(/->|→|=>/)[0];
  const object = objectOf((graph.nodes.find(n => n.line === 3) || {}).location);
  const ran = new Set([1, 3, 6]);
  const ordered = { ...graph, pipeline: { steps: [{ modifier_class: object, step_no: 1 }], scenario: "", byRun: true } };
  const text = formula(ordered, definition => ran.has(Number(definition.line))).expression.text;
  assert.equal(text, "A = (10 + 1) * 2");
});
