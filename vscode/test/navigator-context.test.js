"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

test("Navigator reports its loaded tree without source code", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "org.vertex.abap.ui", "resources", "navigator.html"), "utf8");
  const start = html.indexOf("let loading = false;");
  const end = html.indexOf("/* One answer at a time", start);
  const root = { tagName: "LI", __vertexNode: { label: "Z_RIG", children: [] }, __vertexLoaded: true, parentElement: null };
  const group = { tagName: "LI", __vertexNode: { label: "Classes", children: [] }, __vertexLoaded: true,
    parentElement: { tagName: "UL", parentElement: root } };
  const klass = { tagName: "LI", __vertexNode: { label: "ZCL_CALC_FACADE", open: { name: "ZCL_CALC_FACADE", type: "CLAS" },
    expand: { name: "ZCL_CALC_FACADE", type: "CLAS" } }, __vertexLoaded: false,
    parentElement: { tagName: "UL", parentElement: group } };
  const sent = [];
  const context = { initial: { name: "Z_RIG", type: "DEVC" }, document: { querySelectorAll: () => [root, group, klass] },
    sdeContextUpdate: state => sent.push(state) };
  vm.runInNewContext(html.slice(start, end), context);
  context.publishContext();
  const view = sent[0].vertex_view;
  assert.equal(view.view, "navigator");
  assert.equal(view.name, "Z_RIG");
  assert.equal(view.partial, true);
  assert.deepEqual(Array.from(view.loaded_nodes.map(node => [node.depth, node.label])),
    [[0, "Z_RIG"], [1, "Classes"], [2, "ZCL_CALC_FACADE"]]);
  assert.equal(view.loaded_nodes[2].type, "CLAS");
  assert.equal(JSON.stringify(view).includes("source"), false);
});
