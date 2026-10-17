"use strict";
const vscode = require("vscode");
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("vertexProbe.report", async () => {
    const out = { vscode: vscode.version, node: process.versions.node, electron: process.versions.electron,
      napi: process.versions.napi, platform: process.platform, arch: process.arch,
      remoteName: vscode.env.remoteName || null };
    for (const name of ["@mcp-abap-adt/auth-broker", "@mcp-abap-adt/connection", "@mcp-abap-adt/sap-rfc-lite"]) {
      try { require(name); out[name] = "loaded"; } catch (e) { out[name] = "failed: " + e.message; }
    }
    const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(out, null, 2) });
    await vscode.window.showTextDocument(doc);
  }));
}
module.exports = { activate, deactivate() {} };
