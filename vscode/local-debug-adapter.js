"use strict";

const fs = require("fs");
const path = require("path");

function create(vscode, document, launch, publish) {
  const name = path.basename(document.uri.fsPath).replace(/\.(?:prog|clas|intf)\.abap$/i, "").toUpperCase();
  let latest = null, listening = false, ended = 0, error = "", pendingStep = null;
  let trace = [], traceIndex = 0, live = null;
  function atTrace(index) {
    traceIndex = index;
    const values = {};
    for (let i = 0; i <= index; i++) Object.assign(values, trace[i]?.changed || {});
    const record = trace[index];
    latest = record ? { frame: record.routine || "START-OF-SELECTION", owner: record.owner || name,
      source: record.file, line: record.line,
      variables: Object.entries(values).map(([name, value]) => ({ name, value })) } : null;
    publish(picture());
  }
  const isAbap = uri => uri?.scheme === "file" && /\.abap$/i.test(uri.fsPath || "");
  const points = () => (vscode.debug.breakpoints || []).filter(bp => isAbap(bp.location?.uri)).map(bp => ({
    id: bp.id, objectType: "PROG", name: path.basename(bp.location.uri.fsPath).split(".")[0].toUpperCase(),
    url: bp.location.uri.fsPath, line: bp.location.range.start.line + 1,
    condition: bp.condition || "", mode: "stop", active: bp.enabled !== false
  }));
  const picture = () => {
    const source = /\.abap$/i.test(latest?.source || "") ? latest.source : document.uri.fsPath,
      line = latest?.line || 0;
    const breakpoints = points();
    const hit = breakpoints.find(bp => bp.active && bp.url.toLowerCase() === source.toLowerCase() && bp.line === line);
    return { system: "Transpiler", listening, ended, ending: null, error, breakpoints,
      stopped: latest?.frame && line ? { at: name + ":" + line, breakpoint: hit || null,
        frames: [{ n: 0, current: true, label: "EVENT " + latest.frame,
          program: latest.owner || name, include: latest.owner || name, unitType: "EVENT", unit: latest.frame,
          url: source, line }] } : null };
  };
  function update(state) {
    latest = state?.frame ? state : null; error = state?.error || "";
    if (latest && pendingStep && (state.stopEvent || pendingStep.sawContinued)) {
      const done = pendingStep; pendingStep = null; done.resolve({});
    } else if (state?.continued && pendingStep) pendingStep.sawContinued = true;
    publish(picture());
  }
  function finish() {
    if (!listening && !latest) return;
    latest = null; listening = false; ended++;
    if (pendingStep) { const done = pendingStep; pendingStep = null; done.resolve({ ended: true }); }
    publish(picture());
  }
  const shown = variable => {
    const value = variable.value;
    const composite = value !== null && typeof value === "object";
    return { id: variable.id || variable.name, name: variable.name,
      meta: Array.isArray(value) ? "table" : composite ? "structure" : "simple",
      type: variable.type || "", technical: "",
      value: Array.isArray(value) ? value.length + " rows" : composite ? Object.keys(value).length + " fields" : String(value ?? "") };
  };
  const nested = id => {
    const parts = String(id).split("-");
    let value = (latest?.variables || []).find(item => item.name.toUpperCase() === parts.shift().toUpperCase())?.value;
    for (const part of parts) value = value?.[part.toLowerCase()] ?? value?.[part];
    return value && typeof value === "object" ? Object.entries(value).map(([name, value]) =>
      shown({ id: id + "-" + name, name, value })) : [];
  };
  const localGroups = () => [{ id: "vertex-local-variables", name: "Locals",
    children: (latest?.variables || []).map(shown) }];
  async function command(action, args = {}) {
    switch (action) {
      case "picture": return picture();
      case "run": {
        live?.stop(); live = null;
        latest = null; error = ""; listening = true; trace = []; publish(picture());
        const result = await launch(args.selection || {});
        live = result?.live || null;
        trace = result?.records || [];
        let ended = !live;
        const first = trace[0], breakpoints = points();
        if (live && first && !breakpoints.some(bp => bp.active && bp.url.toLowerCase() === first.file.toLowerCase() && bp.line === first.line)) {
          const next = await live.next("continue", breakpoints);
          trace.push(...next.records); ended = next.ended;
        }
        atTrace(Math.max(0, trace.length - 1)); listening = false;
        return { url: document.uri.fsPath, trace, ended, output: live?.output || result?.output || "" };
      }
      case "trace": return { trace };
      case "step": {
        if (args.live) {
          if (!live) return { records: [], ended: true, picture: picture(), groups: localGroups() };
          const next = await live.next(args.kind, points());
          trace.push(...next.records);
          atTrace(trace.length - 1);
          return { records: next.records, ended: next.ended, picture: picture(), groups: localGroups() };
        }
        if (trace.length) {
          let next = Math.min(trace.length - 1, traceIndex + 1);
          if (args.kind === "continue") {
            const breakpoints = points();
            const hit = trace.findIndex((record, index) => index > traceIndex && breakpoints.some(bp =>
              bp.active && bp.url.toLowerCase() === record.file.toLowerCase() && bp.line === record.line));
            next = hit >= 0 ? hit : trace.length - 1;
          }
          atTrace(next);
          return { picture: picture(), groups: localGroups(), ended: next === trace.length - 1 };
        }
        const key = { into: "stepInto", over: "stepOver", out: "stepOut", continue: "continue" }[args.kind];
        if (!key) throw new Error("Unknown debug step.");
        if (!args.wait) { await vscode.commands.executeCommand("workbench.action.debug." + key); return {}; }
        const result = new Promise(resolve => {
          const timer = setTimeout(() => { pendingStep = null; resolve({ timeout: true }); }, 15000);
          pendingStep = { resolve: value => { clearTimeout(timer); resolve(value); }, sawContinued: false };
        });
        try { await vscode.commands.executeCommand("workbench.action.debug." + key); }
        catch (error) { if (pendingStep) { const done = pendingStep; pendingStep = null; done.resolve({ error: error.message }); } }
        const stopped = await result;
        return { ...stopped, picture: picture(), groups: localGroups() };
      }
      case "localSnapshot": return { groups: localGroups() };
      case "source": return { url: args.url, source: fs.readFileSync(args.url || document.uri.fsPath, "utf8") };
      case "scopes": return { groups: [{ id: "vertex-local-variables", name: "Locals" }], sy: null };
      case "children": return { id: args.id, children: args.id === "vertex-local-variables" ?
        (latest?.variables || []).map(shown) : nested(args.id) };
      case "vars": return { variables: (latest?.variables || []).filter(v =>
        !args.names || args.names.some(n => n.toUpperCase() === v.name.toUpperCase())).map(shown) };
      case "set": {
        const uri = vscode.Uri.file(args.url || document.uri.fsPath);
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri,
          new vscode.Position(Math.max(0, args.line - 1), 0)), true, args.condition || undefined);
        vscode.debug.addBreakpoints([bp]); return { id: bp.id };
      }
      case "clear": vscode.debug.removeBreakpoints((vscode.debug.breakpoints || []).filter(bp =>
        !args.id || bp.id === args.id)); return {};
      case "activate": return {};
      case "stop": case "detach": case "terminate":
        live?.stop(); live = null;
        await vscode.debug.stopDebugging(); finish(); return {};
      case "settle": return { settled: !listening };
      case "frame": return {};
      case "methods": return { methods: [] };
      case "copy": await vscode.env.clipboard.writeText(String(args.text || "")); return {};
      case "checkdumps": return { dumped: [] };
      case "opendump": return {};
    }
    throw new Error("Local Visual Debug does not support " + action + " yet.");
  }
  // A new Visual Debug window starts clean: the paused transpiler process of this one ends with it.
  const dispose = () => { live?.stop(); live = null; trace = []; latest = null; };
  return { picture, update, finish, command, dispose, hasTrace: () => trace.length > 0 };
}

module.exports = { create };
