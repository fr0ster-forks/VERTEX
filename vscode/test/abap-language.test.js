"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../package.json");

test("VERTEX registers ABAP without requiring another extension", () => {
  const language = manifest.contributes.languages.find(item => item.id === "abap");
  assert.ok(language, "opening SAP source must not depend on another ABAP extension");
  assert.ok(language.extensions.includes(".abap"));
  assert.ok(language.aliases.includes("ABAP"));
});
