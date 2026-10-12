"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { projectFor, scenariosFor, transpile, stageRuntime, entryFor } = require("../local-run");

test("local report launch uses the generated program and retains its ABAP map", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-local-run-"));
  try {
    const source = path.join(root, "src", "zcalc.prog.abap");
    const cli = path.join(root, "node_modules", "@abaplint", "transpiler-cli", "abap_transpile");
    const generated = path.join(root, "output", "project", "zcalc.prog.mjs");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.writeFileSync(source, "REPORT zcalc.\nWRITE 5.\n");
    fs.writeFileSync(cli, "");
    fs.writeFileSync(generated, "//# sourceMappingURL=zcalc.prog.mjs.map\n");
    fs.writeFileSync(path.join(root, "abap_transpile.json"), JSON.stringify({ output_folder: "output", write_source_map: true }));
    const document = { uri: { scheme: "file", fsPath: source }, getText: () => fs.readFileSync(source, "utf8") };
    const entry = entryFor(projectFor(document), document);
    const wrapper = fs.readFileSync(entry, "utf8");
    assert.match(wrapper, /\.\/project\/zcalc\.prog\.mjs/);
    assert.match(wrapper, /abap\.console\.get\(\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automatic configuration and selected radio value execute without project npm files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-auto-run-"));
  let project;
  try {
    const source = path.join(root, "src", "zcalc.prog.abap");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "REPORT zcalc.\nPARAMETERS p_a RADIOBUTTON GROUP sc DEFAULT 'X'.\n" +
      "PARAMETERS p_b RADIOBUTTON GROUP sc.\nSTART-OF-SELECTION.\nWRITE: / p_a, p_b.\n");
    const document = { uri: { scheme: "file", fsPath: source }, getText: () => fs.readFileSync(source, "utf8") };
    project = projectFor(document, root);
    assert.equal(project.automatic, true);
    assert.equal(fs.existsSync(path.join(root, "abap_transpile.json")), false);
    assert.equal(scenariosFor(document)[0].choices.length, 2);
    await transpile(project, { append() {} });
    stageRuntime(project);
    const entry = entryFor(project, document, { SC: "P_B" });
    assert.match(execFileSync(process.execPath, [entry], { cwd: root, encoding: "utf8" }), / X/);
    const generated = path.join(path.dirname(project.entry), "project", "zcalc.prog.mjs");
    const map = JSON.parse(fs.readFileSync(generated + ".map", "utf8"));
    assert.equal(path.resolve(path.dirname(generated), map.sources[0]), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (project?.automatic) fs.rmSync(path.dirname(project.configFile), { recursive: true, force: true });
  }
});

test("bundled transpiler and runtime serve a project without npm dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-bundled-run-"));
  try {
    const source = path.join(root, "src", "zcalc.prog.abap");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "REPORT zcalc.\n");
    fs.writeFileSync(path.join(root, "abap_transpile.json"), JSON.stringify({ output_folder: "output", write_source_map: true }));
    const project = projectFor({ uri: { scheme: "file", fsPath: source } });
    assert.equal(project.cli, path.join(__dirname, "..", "node_modules", "@abaplint", "transpiler-cli", "abap_transpile"));
    stageRuntime(project);
    for (const name of ["@abaplint/runtime", "temporal-polyfill", "temporal-spec", "temporal-utils"]) {
      assert.equal(fs.existsSync(path.join(root, "output", "node_modules", ...name.split("/"), "package.json")), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
