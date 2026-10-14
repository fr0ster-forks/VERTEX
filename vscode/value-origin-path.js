"use strict";
/* The analysis's formula as one recorded run made it, for both hosts. Only the definitions whose statement the run
   executed take part, so the variants the analysis keeps for other paths fall away; definitions of one value that all
   ran - every modifier of a pipeline - are steps in the order the run made them, given to the formula as its pipeline.
   executed: [{ object, line }] in the order the record holds them. */
const { formula } = require("./value-origin-formula");
const paneHtml = require("./value-origin-formula-html");

function pathFormula(graph, executed, sourceOf = node => "origin:" + node.source + "|" + (node.location || "")) {
  if (!graph) throw new Error("No path was analysed: use Analyze flow path first.");
  const up = text => String(text || "").toUpperCase();
  const objectOf = location => up(String(location || "").split(/->|→|=>/)[0]);
  const ran = new Set((executed || []).map(item => up(item.object) + ":" + Number(item.line)));
  const order = [];
  (executed || []).forEach(item => { const object = up(item.object); if (object && !order.includes(object)) order.push(object); });
  const ordered = { ...graph, pipeline: { steps: order.map((object, index) => ({ modifier_class: object, step_no: index + 1 })), scenario: "", byRun: true } };
  const derived = formula(ordered, definition => ran.has(objectOf(definition.location) + ":" + Number(definition.line)));
  return { formula: { nodes: derived.nodes, edges: derived.edges, maxLevel: derived.maxLevel },
    panes: { formula: paneHtml.formulaPane(ordered, derived, sourceOf), expression: paneHtml.expressionPane(derived, sourceOf) } };
}

module.exports = { pathFormula };
