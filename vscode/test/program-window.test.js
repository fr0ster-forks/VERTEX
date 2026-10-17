"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { html } = require("../program-window");

test("the program window carries the shared selection screen, its toolbar and no colour of its own", () => {
  const page = html({ name: "ZSEL", recompile: true, builtAt: "" });
  assert.match(page, /function drawScreen\(/, "the screen code shared with Visual Debug is put in");
  assert.doesNotMatch(page, /SELECTION-SCREEN-UI\*\//);
  for (const id of ["execute", "back", "flow", "recompile", "list", "statusbar"]) assert.match(page, new RegExp('id="' + id + '"'));
  const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
  assert.doesNotMatch(css.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ""), /#[0-9a-f]{3,6}\b|rgb\(/i, "every colour is a theme variable");
  for (const script of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(script[1]);
});
