"use strict";
function refusalFor(system, { platform = process.platform, remoteName, resolve = require.resolve } = {}) {
  if (system.authType !== "snc") return null;
  if (remoteName) return "SNC needs the local VS Code on Windows or macOS; this window runs on a remote host (" + remoteName + ").";
  if (platform !== "win32" && platform !== "darwin") return "SNC runs on Windows and macOS only.";
  try { resolve("@mcp-abap-adt/sap-rfc-lite"); }
  catch (_) { return "This VERTEX package has no SNC support; install the Windows or macOS package of VERTEX."; }
  return null;
}
module.exports = { refusalFor };
