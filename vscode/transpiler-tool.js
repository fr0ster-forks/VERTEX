"use strict";

const schema = {
  name: "run_abap_transpiler",
  annotations: { readOnlyHint: true, destructiveHint: false },
  description: "Run an ABAP report, class method or function module with the local transpiler and return its output. This simulates ABAP execution; it is not a SAP runtime run. SELECT may read the selected SAP system through VERTEX. Parallel runs use isolated local projects. Use this first for runnable code; if compilation or runtime says the case is unsupported, explain why and ask the user whether to run it in SAP. For a class, read its source and supply entry_line inside the method. Supply selection values for reports that need parameters.",
  inputSchema: { type: "object", additionalProperties: false, required: ["object_type", "object_name"], properties: {
    object_type: { type: "string", enum: ["PROG", "CLAS", "FUNC"] },
    object_name: { type: "string", description: "Exact SAP technical name." },
    entry_line: { type: "integer", minimum: 1, description: "Line inside the class method or function module to execute. Required for CLAS." },
    screen_only: { type: "boolean", description: "Return the selection screen or method argument fields without executing." },
    selection: { type: "object", description: "Selection screen values. Radio group IDs map to chosen parameter names; other values go in $parameters. For a method or function module, supply its $entry arguments.", additionalProperties: true },
    system: { type: "string", description: "Configured SAP system; defaults to the active system." }
  } }
};

function validate(args) {
  const kind = String(args?.object_type || "").toUpperCase();
  if (!["PROG", "CLAS", "FUNC"].includes(kind)) throw new Error("The transpiler can run PROG, CLAS or FUNC only.");
  const object_name = String(args?.object_name || "").toUpperCase();
  if (!/^[A-Z0-9_/$]+$/.test(object_name) || object_name.length > 40) throw new Error("Use an exact SAP object name.");
  if (kind === "CLAS" && (!Number.isInteger(args.entry_line) || args.entry_line < 1))
    throw new Error("Read the class source and supply entry_line inside the method to run.");
  if (args.entry_line !== undefined && (!Number.isInteger(args.entry_line) || args.entry_line < 1))
    throw new Error("entry_line must be a positive source line.");
  if (args.selection !== undefined && (!args.selection || Array.isArray(args.selection) || typeof args.selection !== "object"))
    throw new Error("selection must be an object of parameter values.");
  return { object_name, object_type: kind, entryLine: args.entry_line || 0, selection: args.selection || {} };
}

function describeScreen(screen) {
  return (screen?.elements || []).filter(e => !e.hidden && ["parameter", "select-option"].includes(e.kind))
    .map(e => ({ name: e.name, label: screen.texts?.selections?.[e.name] || e.name, kind: e.kind,
      ...(e.radio ? { radio_group: e.radio } : {}), ...(e.checkbox ? { checkbox: true } : {}),
      ...(e.obligatory ? { obligatory: true } : {}), ...(e.default ? { default: e.default } : {}) }));
}

function missingSelection(screen, selection) {
  return (screen?.elements || []).filter(e => e.obligatory && !e.hidden && !e.radio &&
    (e.kind === "parameter" || e.kind === "select-option")).filter(e => {
    if (e.kind === "select-option") return !(selection.$ranges?.[e.name]?.length || e.default?.low);
    const value = selection.$parameters?.[e.name];
    return !(value !== undefined ? String(value).trim() : String(e.default || "").trim());
  }).map(e => e.name);
}

function missingEntry(entry, selection) {
  const values = selection.$entry || {};
  return [
    ...(entry.creation || []).filter(p => !p.optional && !p.default && values.creation?.[p.name] === undefined)
      .map(p => "constructor " + p.name),
    ...(entry.parameters || []).filter(p => ["importing", "changing", "tables"].includes(p.direction)
      && !p.optional && !p.default && values.parameters?.[p.name] === undefined).map(p => p.name)
  ];
}

function createRunQueue() {
  let tail = Promise.resolve();
  return work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}

module.exports = { schema, validate, describeScreen, missingSelection, missingEntry, createRunQueue };
