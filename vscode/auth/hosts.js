"use strict";
function refusalFor(system, { platform = process.platform, arch = process.arch, remoteName, resolve = require.resolve } = {}) {
  if (system.authType !== "snc") return null;
  if (remoteName) return "SNC needs the local VS Code on Windows or macOS; this window runs on a remote host (" + remoteName + ").";
  if (!(platform === "win32" && arch === "x64") && !(platform === "darwin" && arch === "arm64"))
    return "SNC runs on Windows x64 and macOS on Apple silicon only.";
  try { resolve("@mcp-abap-adt/sap-rfc-lite"); }
  catch (_) { return "This VERTEX package has no SNC support: the RFC binding is missing."; }
  return null;
}
module.exports = { refusalFor };
