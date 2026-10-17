"use strict";
/* The build of an SAP object's transpiler run - the sources and the dictionary it read - kept between runs. As SAP runs a
   program's load and not its text, a run takes the kept build as it is, without asking SAP whether anything changed;
   Recompile reads it again. One folder per system and object holds the build and the project written from it. */
const fs = require("fs");
const path = require("path");
const os = require("os");

const up = value => String(value || "").toUpperCase();

function cacheFolder(systemKey, object) {
  const safe = value => String(value || "").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(os.tmpdir(), "vertex-sap-abap", safe(systemKey), safe(up(object.object_type)) + "-" + safe(up(object.object_name)));
}
function readKept(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, "vertex-read.json"), "utf8")); } catch (_) { return null; }
}
function keep(folder, read) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "vertex-read.json"), JSON.stringify(read));
}

module.exports = { cacheFolder, readKept, keep };
