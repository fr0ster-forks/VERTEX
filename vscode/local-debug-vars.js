"use strict";

async function readVariables(session, threadId) {
  const stack = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 });
  const frame = stack.stackFrames?.[0];
  if (!frame) return { frame: "", variables: [] };
  const scopes = await session.customRequest("scopes", { frameId: frame.id });
  const variables = [];
  for (const scope of scopes.scopes || []) {
    if (scope.name.toLowerCase().includes("global")) continue;
    const response = await session.customRequest("variables", { variablesReference: scope.variablesReference });
    for (const variable of response.variables || []) {
      if (variables.length >= 60) break;
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
    if (variables.length >= 60) break;
  }
  return { frame: frame.name || "", variables };
}

function register(vscode, context, report) {
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory("node", {
    createDebugAdapterTracker(session) {
      if (session.name !== "VERTEX Local ABAP") return undefined;
      return { onDidSendMessage(message) {
        if (message.type !== "event") return;
        if (message.event === "continued" || message.event === "terminated") {
          report({ frame: "", variables: [] });
        } else if (message.event === "stopped") {
          setTimeout(() => readVariables(session, message.body?.threadId).then(report, error =>
            report({ error: error.message, frame: "", variables: [] })), 50);
        }
      } };
    }
  }));
}

module.exports = { readVariables, register };
