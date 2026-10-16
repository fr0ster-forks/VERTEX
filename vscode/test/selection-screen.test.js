"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { selectionScreen, textPoolOf, adtTexts } = require("../selection-screen");
const run = require("../local-run");

const PROGRAM = `REPORT zsel.
DATA gv_n TYPE i.
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE TEXT-001.
PARAMETERS: p_name TYPE c LENGTH 10 DEFAULT 'abc' OBLIGATORY,
            p_flag AS CHECKBOX DEFAULT 'X'.
SELECT-OPTIONS s_n FOR gv_n DEFAULT 1 TO 5.
SELECTION-SCREEN END OF BLOCK b1.
PARAMETERS: r_a RADIOBUTTON GROUP g1, r_b RADIOBUTTON GROUP g1 DEFAULT 'X'.
SELECTION-SCREEN BEGIN OF SCREEN 100.
PARAMETERS p_other TYPE i.
SELECTION-SCREEN END OF SCREEN 100.
SELECTION-SCREEN PUSHBUTTON 2(10) TEXT-004 USER-COMMAND go.
START-OF-SELECTION.
  DATA lv_hits TYPE i.
  DO 10 TIMES.
    IF sy-index IN s_n.
      lv_hits = lv_hits + 1.
    ENDIF.
  ENDDO.
  WRITE: / p_name, p_flag, r_b, lv_hits, lines( s_n ).
`;

test("the screen's elements in their order: a chain taken apart, another screen left out, what cannot be drawn named", () => {
  const elements = selectionScreen(PROGRAM).elements;
  assert.deepEqual(elements.map(e => e.kind + (e.name ? " " + e.name : "")), ["block B1", "parameter P_NAME", "parameter P_FLAG",
    "select-option S_N", "end-block", "parameter R_A", "parameter R_B", "note"]);
  const name = elements[1], range = elements[3];
  assert.deepEqual([name.length, name.obligatory, name.upper, name.default, name.start], [10, true, true, "abc", 4]);
  assert.equal(elements[2].start, 4, "the chain's second piece starts where the chain does");
  assert.deepEqual([range.type, range.numeric, range.default], ["I", true, { sign: "I", option: "BT", low: "1", high: "5" }]);
  assert.deepEqual(elements[0].title, { symbol: "001" });
  assert.equal(run.scenariosFor({ getText: () => PROGRAM })[0].default, "R_B");
});

test("selection texts and text symbols, from abapGit's text pool and from ADT", () => {
  const pool = textPoolOf("<TPOOL><item><ID>I</ID><KEY>001</KEY><ENTRY>Main block</ENTRY></item>" +
    "<item><ID>S</ID><KEY>P_NAME</KEY><ENTRY>        Customer name</ENTRY></item></TPOOL>");
  assert.deepEqual(pool, { selections: { P_NAME: "Customer name" }, symbols: { "001": "Main block" } });
  assert.deepEqual(adtTexts("P_COUNT =Count\n\n@DDICReference\nP_TABCL =Kind\nP_X =?...", "@MaxLength:20\n001=Title"),
    { selections: { P_COUNT: "Count", P_TABCL: "Kind" }, symbols: { "001": "Title" } });
});

test("a program with a framed block, a sized parameter and SELECT-OPTIONS runs with the screen's values", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-screen-"));
  try {
    const file = path.join(folder, "zsel.prog.abap");
    fs.writeFileSync(file, PROGRAM.replace(/^SELECTION-SCREEN PUSHBUTTON.*\n/m, ""));
    const document = { uri: { scheme: "file", fsPath: file }, getText: () => fs.readFileSync(file, "utf8"), isDirty: false };
    const vscode = { workspace: { getWorkspaceFolder: () => undefined },
      window: { createOutputChannel: () => ({ append() {}, appendLine() {}, hide() {}, show() {} }) } };
    const defaults = await run.launch(vscode, false, { document, selection: {}, trace: true });
    assert.match(defaults.output, /^ABC\s+X\s*X\s*5\s*1/, "the DEFAULTs, upper-cased as SAP does: 5 of 10 in 1..5");
    const given = await run.launch(vscode, false, { document, trace: true, selection: { G1: "R_A", $parameters: { P_NAME: "xyz" },
      $ranges: { S_N: [{ low: "2", high: "4", option: "BT" }, { option: "EQ", low: "9" }] } } });
    assert.match(given.output, /^XYZ\s+X\s*4\s*2/, "R_B cleared, 2..4 and 9 hit four times in two rows");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
