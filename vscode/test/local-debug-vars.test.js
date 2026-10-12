"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readVariables } = require("../local-debug-vars");

test("local stop reads the current frame and unwraps ABAP scalar values", async () => {
  const calls = [];
  const session = { async customRequest(command, args) {
    calls.push([command, args]);
    if (command === "stackTrace") return { stackFrames: [{ id: 7, name: "START-OF-SELECTION" }] };
    if (command === "scopes") return { scopes: [{ name: "Local", variablesReference: 11 }] };
    if (command === "variables") return { variables: [{ name: "p_clean", value: "Character", variablesReference: 12 }] };
    if (command === "evaluate") return { result: "'X'" };
    throw new Error(command);
  } };
  const state = await readVariables(session, 2);
  assert.equal(state.frame, "START-OF-SELECTION");
  assert.deepEqual(state.variables, [{ scope: "Local", name: "p_clean", value: "'X'" }]);
  assert.deepEqual(calls.map(call => call[0]), ["stackTrace", "scopes", "variables", "evaluate"]);
});
