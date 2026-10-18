"use strict";

// A generic request to debug ABAP is a local transpiler request. Expose the
// SAP debugger only when the user explicitly chooses the SAP runtime.
function sapDebuggerRequested(prompt, history = []) {
  const text = String(prompt || "").trim();
  const runtime = /\bSAP\b|\bWebGUI\b|\bADT debugger\b|\bSAP debugger\b|\bSAP run\b|\bSAP runtime\b|\bABAP backend\b|\bСАП\b|в реальн(?:ой|ом) SAP|на сервере SAP|обычн(?:ый|ом) дебаггер/i;
  const action = /debug|run|запус|отлад|дебаг|выполн|исполн/i;
  if (runtime.test(text) && action.test(text) && !/не\s+(?:надо|нужно|запускай)|without SAP|not in SAP/i.test(text)) return true;
  if (!/^(?:да|yes|ок|okay|запускай|согласен)[.!\s]*$/i.test(text)) return false;
  const previous = [...history].reverse().find(item => item.role === "assistant");
  return !!previous && /(?:запус|run).{0,60}(?:\bSAP\b|САП)|(?:\bSAP\b|САП).{0,60}(?:запус|run)/i.test(previous.content || "")
    && /\?|хотите|want|разреш/i.test(previous.content || "");
}

module.exports = { sapDebuggerRequested };
