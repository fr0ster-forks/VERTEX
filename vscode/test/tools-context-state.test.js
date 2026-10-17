"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../tools-context-state");

test("the active UML panel supplies chat context even when another panel reports later", () => {
  const contexts = create();
  const first = { active: true }, second = { active: false };
  const uml = { vertex_view: { name: "Z_RIG", view: "uml", uml: { nodes: [{ name: "ZCL_RIG" }], edges: [] } } };
  contexts.update(first, uml);
  contexts.update(second, { vertex_view: { name: "Z_OTHER", view: "metrics" } });
  assert.equal(contexts.current(), uml);

  first.active = false;
  second.active = true;
  contexts.update(second, undefined);
  assert.equal(contexts.current().vertex_view.name, "Z_OTHER");

  contexts.update(second, null);
  assert.equal(contexts.current(), null);
  first.active = true;
  assert.equal(contexts.current(), uml);
});
