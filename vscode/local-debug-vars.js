"use strict";

const fs = require("fs");

const sourceNamesCache = new Map();
function abapVariableNames(source) {
  if (!/\.abap$/i.test(source || "")) return null;
  try {
    const stat = fs.statSync(source), cached = sourceNamesCache.get(source);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.names;
    const text = fs.readFileSync(source, "utf8")
      .split(/\r?\n/).filter(line => !/^\s*\*/.test(line))
      .map(line => line.replace(/".*$/, "")).join("\n");
    const names = new Set();
    for (const match of text.matchAll(/\b([a-z][\w]*)\s+(?:TYPE|LIKE)\b/gi)) names.add(match[1].toUpperCase());
    for (const match of text.matchAll(/\b(?:DATA|PARAMETERS|CONSTANTS|STATICS|FIELD-SYMBOLS|SELECT-OPTIONS)\s*(?:\(\s*)?(<?[a-z][\w]*>?)/gi)) {
      if (match[1].toUpperCase() !== "TYPE") names.add(match[1].replace(/[<>]/g, "").toUpperCase());
    }
    for (const match of text.matchAll(/\b(?:DATA|FIELD-SYMBOL)\s*\(\s*([a-z][\w]*)\s*\)/gi)) names.add(match[1].toUpperCase());
    const result = names.size ? names : null;
    sourceNamesCache.set(source, { mtimeMs: stat.mtimeMs, size: stat.size, names: result });
    return result;
  } catch (_) { return null; }
}

async function readVariables(session, threadId) {
  if (!threadId) {
    const threads = await session.customRequest("threads", {});
    threadId = threads.threads?.[0]?.id;
  }
  const stack = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 });
  const frame = stack.stackFrames?.[0];
  if (!frame) return { frame: "", variables: [] };
  const names = abapVariableNames(frame.source?.path);
  const scopes = await session.customRequest("scopes", { frameId: frame.id });
  const variables = [];
  for (const scope of scopes.scopes || []) {
    if (scope.name.toLowerCase().includes("global")) continue;
    const response = await session.customRequest("variables", { variablesReference: scope.variablesReference });
    for (const variable of response.variables || []) {
      if (variable.name === "this") continue;
      if (names ? !names.has(variable.name.replace(/[<>]/g, "").toUpperCase()) :
        /^(?:unique\d+|indexBackup\d+|abap|exports|require|module|process)$/i.test(variable.name)) continue;
      let value = variable.value;
      if (/^[A-Za-z_$][\w$]*$/.test(variable.name) && variable.variablesReference) {
        try {
          const evaluated = await session.customRequest("evaluate", {
            expression: variable.name + ".get()", frameId: frame.id, context: "watch"
          });
          if (evaluated?.result != null) value = evaluated.result;
        } catch (_) { /* Keep the debugger's own representation. */ }
      }
      variables.push({ scope: scope.name, name: variable.name, value });
    }
  }
  return { frame: frame.name || "", source: frame.source?.path || "", line: frame.line || 0, variables };
}

function declarationLine(text) {
  // Inline DATA(...) with an initializer is an executable statement.
  if (/^\s*DATA\s*\([^)]*\)\s*=/i.test(text)) return false;
  return /^\s*(?:DATA|TYPES|CONSTANTS|STATICS|FIELD-SYMBOLS|PARAMETERS|SELECT-OPTIONS)\b/i.test(text);
}

async function pollVariables(session) {
  const threads = await session.customRequest("threads", {});
  const threadId = threads.threads?.[0]?.id;
  return threadId ? readVariables(session, threadId) : { frame: "", variables: [] };
}

async function removeDeclarationBreakpoints(vscode, breakpoints) {
  const invalid = [];
  for (const breakpoint of breakpoints) {
    const uri = breakpoint.location?.uri, line = breakpoint.location?.range?.start?.line;
    if (uri?.scheme !== "file" || !/\.abap$/i.test(uri.fsPath || "") || !Number.isInteger(line)) continue;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (line < document.lineCount && declarationLine(document.lineAt(line).text)) invalid.push(breakpoint);
    } catch (_) { /* The source may have been removed. */ }
  }
  if (invalid.length) vscode.debug.removeBreakpoints(invalid);
  return invalid.length;
}

function register(vscode, context, report, localPanel = () => false) {
  const hiddenDebugViews = new Set();
  const isLocalSession = session => session && (session.name === "VERTEX Local ABAP" ||
    /vertex-local-entry\.mjs$/i.test(session.configuration?.program || "") ||
    (session.parentSession && isLocalSession(session.parentSession)));
  const factory = {
    createDebugAdapterTracker(session) {
      if (!isLocalSession(session)) return undefined;
      return { onDidSendMessage(message) {
        if (message.type !== "event") return;
        if (message.event === "continued" || message.event === "terminated") {
          report({ frame: "", variables: [], continued: message.event === "continued" });
        } else if (message.event === "stopped") {
          if (!hiddenDebugViews.has(session.id)) {
            hiddenDebugViews.add(session.id);
            setTimeout(() => { void vscode.commands?.executeCommand("workbench.view.explorer"); }, 100);
          }
          setTimeout(() => readVariables(session, message.body?.threadId).then(state => report({ ...state, stopEvent: true }), error =>
            report({ error: error.message, frame: "", variables: [] })), 50);
        }
      } };
    }
  };
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory("*", factory));
  let polling = false, lastState = "", lastSessionId = "", failures = 0;
  const timer = setInterval(async () => {
    const session = vscode.debug.activeDebugSession;
    if (polling || !isLocalSession(session)) return;
    if (session.id !== lastSessionId) { lastSessionId = session.id; lastState = ""; failures = 0; }
    polling = true;
    try {
      const state = await pollVariables(session);
      if (!state.frame) return;
      failures = 0;
      const serialized = JSON.stringify(state);
      if (serialized !== lastState) { lastState = serialized; report(state); }
    } catch (error) {
      if (++failures === 5) report({ error: "Debugger variables unavailable: " + error.message,
        frame: "", variables: [] });
    }
    finally { polling = false; }
  }, 400);
  context.subscriptions.push({ dispose() { clearInterval(timer); } });
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(event => {
    void removeDeclarationBreakpoints(vscode, event.added || []);
  }));
  void removeDeclarationBreakpoints(vscode, vscode.debug.breakpoints || []);
}

module.exports = { abapVariableNames, readVariables, pollVariables, declarationLine, removeDeclarationBreakpoints, register };
