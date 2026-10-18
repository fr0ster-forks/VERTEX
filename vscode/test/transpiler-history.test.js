"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../transpiler-history");

test("transpiler history pages all steps and reconstructs routine variables", () => {
  const store = create();
  const run_id = store.save([
    { owner: "ZCL_A", routine: "RUN", line: 3, changed: { LS_RESULT: { AMOUNT: 0 } }, sy: { SUBRC: 0 } },
    { owner: "ZCL_A", routine: "RUN", line: 4, changed: { LS_RESULT: { AMOUNT: 10 } } },
    { owner: "ZCL_B", routine: "APPLY", line: 8, changed: { CS_CONTEXT: { AMOUNT: 10 } } },
    { owner: "ZCL_A", routine: "RUN", line: 5, changed: { LV_DONE: "X" } }
  ]);
  const page = store.read({ run_id, from_step: 2, limit: 2, include_state: true });
  assert.equal(page.total_steps, 4);
  assert.equal(page.next_step, 4);
  assert.deepEqual(page.steps[0].variables.LS_RESULT, { AMOUNT: 10 });
  assert.deepEqual(page.steps[1].variables.CS_CONTEXT, { AMOUNT: 10 });
  const last = store.read({ run_id, from_step: 4, include_state: true });
  assert.deepEqual(last.steps[0].variables.LS_RESULT, { AMOUNT: 10 });
  assert.equal(last.next_step, null);
});

test("transpiler virtual watchpoints find changes to a structure field", () => {
  const store = create();
  const run_id = store.save([
    { owner: "ZCL_A", routine: "RUN", line: 3, changed: { LS_RESULT: { AMOUNT: 0 } } },
    { owner: "ZCL_A", routine: "RUN", line: 4, changed: { LS_RESULT: { AMOUNT: 10 } } },
    { owner: "ZCL_A", routine: "RUN", line: 5, changed: { LV_DONE: "X" } }
  ]);
  const found = store.find({ run_id, variable: "LS_RESULT-AMOUNT" });
  assert.deepEqual(found.matches.map(m => [m.step, m.before, m.after]), [[1, null, 0], [2, 0, 10]]);
  assert.deepEqual(store.find({ run_id, object: "ZCL_A", line: 4 }).matches.map(m => m.step), [2]);
});
