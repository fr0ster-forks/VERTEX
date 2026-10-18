"use strict";

const { randomUUID } = require("crypto");

const schema = {
  name: "read_abap_transpiler_history",
  annotations: { readOnlyHint: true, destructiveHint: false },
  description: "Read the recorded steps and variable changes of a run_abap_transpiler result. Call repeatedly with from_step to page through the complete history. Values are the changes at each step; include_state reconstructs all variables visible in that routine at each step. This is local transpiler history, not a SAP runtime trace.",
  inputSchema: { type: "object", additionalProperties: false, required: ["run_id"], properties: {
    run_id: { type: "string" },
    from_step: { type: "integer", minimum: 1, description: "First 1-based step; defaults to 1." },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Steps per page; defaults to 5." },
    include_state: { type: "boolean", description: "Include all routine variables as they stood at each step, reconstructed from changes." }
  } }
};

const findSchema = {
  name: "find_abap_transpiler_stops",
  annotations: { readOnlyHint: true, destructiveHint: false },
  description: "Find virtual breakpoints by ABAP object and line, or watchpoints where a variable changes, in a completed transpiler run. Returns step numbers and variable values before/after; read history around those steps. No rerun or live SAP breakpoint is created.",
  inputSchema: { type: "object", additionalProperties: false, required: ["run_id"], properties: {
    run_id: { type: "string" }, object: { type: "string", description: "ABAP program/class name." },
    line: { type: "integer", minimum: 1 },
    variable: { type: "string", description: "ABAP variable or structure field, e.g. LS_RESULT-AMOUNT. Finds steps where its value changes." },
    from_step: { type: "integer", minimum: 1, description: "Search from this step; defaults to 1." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum matches; defaults to 20." }
  } }
};

function create() {
  const runs = new Map();
  function save(records, meta = {}) {
    const run_id = randomUUID();
    runs.set(run_id, { records, meta });
    while (runs.size > 20) runs.delete(runs.keys().next().value);
    return run_id;
  }
  function read(args = {}) {
    const run = runs.get(String(args.run_id || ""));
    if (!run) throw new Error("Transpiler run history is unavailable; run the program again.");
    const from = args.from_step === undefined ? 1 : args.from_step;
    const limit = args.limit === undefined ? 5 : args.limit;
    if (!Number.isInteger(from) || from < 1 || !Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("from_step must be positive and limit must be 1..20.");
    const states = new Map(), sy = {};
    const steps = [];
    for (let index = 0; index < Math.min(run.records.length, from - 1 + limit); index++) {
      const item = run.records[index], key = String(item.owner || "") + "|" + String(item.routine || "");
      if (!states.has(key)) states.set(key, {});
      Object.assign(states.get(key), item.changed || {});
      Object.assign(sy, item.sy || {});
      if (index < from - 1) continue;
      steps.push({ step: index + 1, object: item.owner, routine: item.routine, line: item.line,
        stack: item.stack, changed: item.changed || {}, sy_changed: item.sy || {}, sql: item.sql || [],
        ...(args.include_state ? { variables: { ...states.get(key) }, sy: { ...sy } } : {}) });
    }
    return { run_id: args.run_id, mode: "transpiler", total_steps: run.records.length,
      from_step: from, steps, next_step: from + steps.length <= run.records.length ? from + steps.length : null,
      ...run.meta };
  }
  function find(args = {}) {
    const run = runs.get(String(args.run_id || ""));
    if (!run) throw new Error("Transpiler run history is unavailable; run the program again.");
    const object = String(args.object || "").toUpperCase(), line = args.line;
    const variable = String(args.variable || "").toUpperCase();
    const from = args.from_step === undefined ? 1 : args.from_step;
    const limit = args.limit === undefined ? 20 : args.limit;
    if ((!variable && (!object || !Number.isInteger(line) || line < 1))
      || (line !== undefined && (!Number.isInteger(line) || line < 1))
      || !Number.isInteger(from) || from < 1
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Specify an object, positive line and valid step range.");
    const matches = [], records = run.records;
    let next_step = null;
    const states = new Map();
    const readVariable = state => {
      if (!variable) return undefined;
      const fields = variable.replace(/->/g, "-").split("-");
      let current = state;
      for (const field of fields) {
        if (!current || typeof current !== "object") return undefined;
        const key = Object.keys(current).find(key => key.toUpperCase() === field);
        if (!key) return undefined;
        current = current[key];
      }
      return current;
    };
    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      const key = String(item.owner || "") + "|" + String(item.routine || "");
      if (!states.has(key)) states.set(key, {});
      const state = states.get(key), before = readVariable(state);
      Object.assign(state, item.changed || {});
      const after = readVariable(state);
      if (i < from - 1 || object && String(item.owner || "").toUpperCase() !== object
        || line !== undefined && item.line !== line
        || variable && (after === undefined || JSON.stringify(before) === JSON.stringify(after))) continue;
      if (matches.length >= limit) { next_step = i + 1; break; }
      matches.push({ step: i + 1, object: item.owner, routine: item.routine, line: item.line,
        ...(variable ? { variable, before: before ?? null, after } : { changed: item.changed || {} }) });
    }
    return { run_id: args.run_id, total_steps: records.length, matches, next_step };
  }
  return { save, read, find };
}

module.exports = { schema, findSchema, create };
