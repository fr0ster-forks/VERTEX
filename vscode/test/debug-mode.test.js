"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { sapDebuggerRequested } = require("../debug-mode");

test("generic debugger requests use the transpiler toolset", () => {
  assert.equal(sapDebuggerRequested("Найди ошибку в Z_CALC дебаггером"), false);
  assert.equal(sapDebuggerRequested("Найди ошибку в SAP коде транспайлером"), false);
});

test("the SAP debugger is available after an explicit runtime choice", () => {
  assert.equal(sapDebuggerRequested("Запусти Z_CALC в SAP debugger"), true);
  assert.equal(sapDebuggerRequested("да", [{ role: "assistant", content: "Хотите запустить программу в SAP?" }]), true);
  assert.equal(sapDebuggerRequested("да", [{ role: "assistant", content: "Запустить в транспайлере?" }]), false);
});
