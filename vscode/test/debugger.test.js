"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, sourceUrl, objectOf } = require("../debugger");

const URL_MAIN = "/sap/bc/adt/programs/programs/z_calc/source/main";

/* The dump feed every fake connection answers with. ST22 is read before a run
   and after one dies, so a connection without it is not a connection the
   debugger can work on. PUSH adds a dump the way SAP would, after the fact. */
function fakeDumps(entries = []) {
  const list = entries.slice();
  const probe = { async dumps() { return { dumps: list.slice() }; } };
  probe.push = d => list.push(Object.assign({ author: "DEVELOPER", type: "text",
    categories: [{ term: "SYNTAX_ERROR", label: "ABAP runtime error" }], links: [{ href: "/sap/bc/adt/runtime/dump/1" }] }, d));
  return probe;
}

/* A fake SAP: the program stops at the lines in STOPS in turn, then ends.
   Each stop carries the variables the program has there. */
function fakeSap({ stops = [], conflict = false, probe = fakeDumps(), dumpOnEnd = null } = {}) {
  const calls = [], sent = [], scopedSent = [];
  let released = null, position = -1;
  const hit = { DEBUGGEE_ID: "D1", PRG_CURR: "Z_CALC", INCL_CURR: "Z_CALC", LINE_CURR: stops[0] && stops[0].line };
  let delivered = false;
  const listener = {
    async debuggerSetBreakpoints(mode, terminal, ide, clientId, bps) {
      sent.push(bps);
      return bps.map((b, i) => {
        const text = typeof b === "string" ? b : b.uri.uri + "#start=" + b.uri.range.start.line;
        const [uri, start] = text.split("#start=");
        if (Number(start) === 999) { return { kind: "line", clientId, errorMessage: "Line 999 is not executable", nonAbapFlavour: "" }; }
        return { kind: "line", clientId, id: "BP" + start, uri: { uri, range: { start: { line: Number(start) } } },
          ...(typeof b === "string" ? {} : { condition: b.condition }) };
      });
    },
    async debuggerListeners() {
      if (conflict) { const e = new Error("conflict"); e.type = "conflictDetected"; e.properties = { conflictText: "Eclipse of DEVELOPER" }; throw e; }
    },
    async debuggerListen() {
      if (!delivered && stops.length) { delivered = true; return hit; }
      await new Promise(resolve => { released = resolve; });
      return undefined;
    },
    async debuggerDeleteListener() { calls.push("deleteListener"); if (released) { released(); } },
    async getObjectSource(url, options) { calls.push("source " + url + " " + options.version); return "REPORT z_calc."; }
  };
  const vars = () => stops[position].vars;
  const session = {
    stateful: "stateful",
    // The stopped program's own breakpoints, scope "debugger".
    async debuggerSetBreakpoints(mode, terminal, ide, clientId, bps, user, scope) {
      scopedSent.push({ scope, bps });
      return bps.map(b => {
        const text = typeof b === "string" ? b : b.uri.uri + "#start=" + b.uri.range.start.line;
        const [uri, start] = text.split("#start=");
        if (Number(start) === 999) { return { kind: "line", clientId, errorMessage: "Line 999 is not executable" }; }
        return { kind: "line", clientId, id: "S" + start, uri: { uri, range: { start: { line: Number(start) } } } };
      });
    },
    async debuggerAttach() { calls.push("attach"); position = 0; return {}; },
    async debuggerStackTrace() {
      calls.push("stack");
      const s = stops[position];
      return { stack: [{ programName: "Z_CALC", includeName: "Z_CALC", line: s.line, eventType: "EVENT", eventName: "START-OF-SELECTION", uri: { uri: URL_MAIN } }] };
    },
    async debuggerChildVariables(parents) {
      calls.push("children");
      if (parents[0] === "@ROOT" && parents.length > 1) {
        return { hierarchies: [{ PARENT_ID: "@ROOT", CHILD_ID: "@GLOBALS" }].concat(vars().map(v => ({ PARENT_ID: "@GLOBALS", CHILD_ID: v.ID }))),
          variables: vars() };
      }
      if (parents[0] === "@ROOT") { return { hierarchies: [{ PARENT_ID: "@ROOT", CHILD_ID: "@GLOBALS" }], variables: [] }; }
      if (parents[0] === "@GLOBALS") { return { hierarchies: vars().map(v => ({ PARENT_ID: "@GLOBALS", CHILD_ID: v.ID })), variables: vars() }; }
      // Components of structured rows: LT_ORDERS[n] -> CUSTOMER
      return { hierarchies: parents.map(p => ({ PARENT_ID: p, CHILD_ID: p + "-CUSTOMER" })),
        variables: parents.map(p => ({ ID: p + "-CUSTOMER", NAME: "CUSTOMER", META_TYPE: "simple", VALUE: "CUST_" + p.slice(-2, -1) })) };
    },
    async debuggerVariables(names) {
      return names.map(n => n.endsWith("]") ? { ID: n, NAME: n, META_TYPE: "structure" }
        : vars().find(v => v.NAME === n));
    },
    async debuggerStep(kind) {
      calls.push(kind);
      position++;
      if (position >= stops.length) {
        // A step that dies writes its dump the way SAP does - after the fact.
        if (dumpOnEnd) { probe.push(dumpOnEnd); }
        throw new Error("An exception was raised");
      }
      return { reachedBreakpoints: stops[position].reached ? [{ id: stops[position].reached }] : [] };
    },
    // ADT's debugger batch: the step and the stack after it, as SAP answers them.
    httpClient: {
      async request(url, options) {
        if (url !== "/sap/bc/adt/debugger/batch") { throw new Error("unexpected request " + url); }
        calls.push("batch");
        const kind = /method=(\w+) HTTP/.exec(options.body)[1];
        const boundary = "ejjeeffe1";
        const part = (status, body) => "--" + boundary + "\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 " + status
          + "\r\nContent-Type: application/xml\r\n\r\n" + body + "\r\n";
        let step;
        try { await session.debuggerStep(kind); step = part("200 OK", '<?xml version="1.0"?><dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true"/>'); }
        catch (error) {
          const failed = '<?xml version="1.0"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><message lang="EN">' + error.message + "</message></exc:exception>";
          return { status: 202, body: part("400 Bad Request", failed) + part("400 Bad Request", failed) + "--" + boundary + "--\r\n" };
        }
        const s = stops[position];
        const stack = '<?xml version="1.0"?><dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger"><dbg:stackEntry programName="Z_CALC" includeName="Z_CALC" line="'
          + s.line + '" eventType="EVENT" eventName="START-OF-SELECTION" uri="' + URL_MAIN + '"/></dbg:stack>';
        let values = "";
        if (/method=getVariables/.test(options.body)) {
          const ids = [...options.body.matchAll(/<ID>([^<]*)<\/ID>/g)].map(m => m[1]);
          const rows = ids.map(id => vars().find(v => v.NAME === id)).filter(Boolean).map(v => "<STPDA_ADT_VARIABLE><ID>" + v.NAME
            + "</ID><NAME>" + v.NAME + "</NAME><META_TYPE>" + v.META_TYPE + "</META_TYPE><VALUE>" + v.VALUE + "</VALUE></STPDA_ADT_VARIABLE>").join("");
          values = part("200 OK", '<?xml version="1.0"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>' + rows + "</DATA></asx:values></asx:abap>");
        }
        let scopes = "";
        if (/method=getChildVariables/.test(options.body)) {
          const row = v => "<STPDA_ADT_VARIABLE><ID>" + v.ID + "</ID><NAME>" + v.NAME + "</NAME><META_TYPE>" + v.META_TYPE + "</META_TYPE><VALUE>" + (v.VALUE || "") + "</VALUE></STPDA_ADT_VARIABLE>";
          const link = (parent, child) => "<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>" + parent + "</PARENT_ID><CHILD_ID>" + child + "</CHILD_ID></STPDA_ADT_VARIABLE_HIERARCHY>";
          scopes = part("200 OK", '<?xml version="1.0"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES>'
            + link("@ROOT", "@GLOBALS") + vars().map(v => link("@GLOBALS", v.ID)).join("") + "</HIERARCHIES><VARIABLES>" + vars().map(row).join("")
            + "</VARIABLES></DATA></asx:values></asx:abap>");
        }
        return { status: 202, body: step + part("200 OK", stack) + values + scopes + "--" + boundary + "--\r\n" };
      }
    },
    async getObjectSource() { return Array.from({ length: 60 }, (_, i) => "line " + (i + 1)).join("\n"); },
    async debuggerGoToStack(position) { calls.push("goto " + position); },
    async logout() { calls.push("logout"); }
  };
  const opened = [];
  const dbg = create({
    ideId: "IDE", terminalId: "TERM",
    openUrl: async url => opened.push(url),
    connect: async () => ({ system: { name: "QAS", url: "https://sap.example:44300", client: "100" }, user: "DEVELOPER",
      listener, probe, open: async () => session })
  });
  return { dbg, calls, sent, opened, scopedSent, probe };
}

const simple = (name, value) => ({ ID: name, NAME: name, META_TYPE: "simple", VALUE: value });
const table = (name, rows) => ({ ID: name + "[]", NAME: name, META_TYPE: "table", TABLE_LINES: rows, VALUE: "[" + rows + "x3]" });

test("a breakpoint URL follows the object type", () => {
  assert.equal(sourceUrl("PROG", "Z_CALC"), URL_MAIN);
  assert.equal(sourceUrl("CLAS", "ZCL_X"), "/sap/bc/adt/oo/classes/zcl_x/source/main");
  assert.equal(sourceUrl("FUNC", "Z_FM", "ZFG"), "/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main");
  assert.throws(() => sourceUrl("FUNC", "Z_FM"), /function group/);
  assert.throws(() => sourceUrl("DDLS", "Z_V"), /not supported/);
});

test("a source URL names its object back, and a class's local include is not one", () => {
  assert.deepEqual(objectOf(URL_MAIN), { objectType: "PROG", name: "Z_CALC" });
  assert.deepEqual(objectOf("/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main#start=3"),
    { objectType: "FUNC", name: "Z_FM", group: "ZFG" });
  assert.equal(objectOf("/sap/bc/adt/oo/classes/zcl_x/includes/implementations"), null);
});

test("the window sees the stop without taking the assistant's news, and steps without taking it either", async () => {
  const { dbg, calls } = fakeSap({ stops: [
    { line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] },
    { line: 46, vars: [simple("LV_TOTAL", "700.00")] }
  ] });
  let told = 0;
  const unwatch = dbg.watch(() => { told++; });
  await dbg.setBreakpointAt({ url: URL_MAIN, line: 45 });
  assert.equal(dbg.picture().breakpoints[0].url, URL_MAIN);
  while (!dbg.picture().stopped) { await new Promise(r => setTimeout(r, 5)); }
  assert.equal(dbg.picture().stopped.at, "Z_CALC:45");
  assert.equal(dbg.picture().stopped.frames[0].url, URL_MAIN);
  assert.ok(told > 0);
  // The variables by scope, and what a scope holds.
  const scopes = await dbg.scopes();
  assert.deepEqual(scopes.groups.map(g => g.id), ["@GLOBALS"]);
  const inside = await dbg.children("@GLOBALS");
  assert.equal(inside[0].value, "600.00");
  // A step from the window: the assistant's wait still gets the stop.
  await dbg.advance("over");
  assert.equal(dbg.picture().stopped.at, "Z_CALC:46");
  const news = await dbg.wait(1);
  assert.equal(news.stopped.at, "Z_CALC:46");
  await dbg.frame(0);
  assert.ok(calls.some(c => /^goto/.test(c)));
  // The active source, read on the stateless connection.
  assert.equal(await dbg.source(URL_MAIN + "#start=1"), "REPORT z_calc.");
  assert.ok(calls.includes("source " + URL_MAIN + " active"));
  unwatch();
  await dbg.stop();
  assert.equal(dbg.picture().stopped, null);
});

test("a table's rows are read for the window's grid", async () => {
  const { dbg } = fakeSap({ stops: [{ line: 23, vars: [table("LT_ORDERS", 3)] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 23 });
  await dbg.wait(5);
  const grid = await dbg.tableRows("LT_ORDERS[]", 1, 2);
  assert.equal(grid.rows, 3);
  assert.equal(grid.shown.length, 2);
  await dbg.stop();
});

test("a condition is attached in a second round, on the line SAP placed", async () => {
  const { dbg, sent } = fakeSap();
  const bp = await dbg.setBreakpoint({ name: "z_calc", line: 45, condition: "lv_customer_total > 1000" });
  assert.equal(bp.id, "bp1");
  assert.deepEqual(sent[0], [URL_MAIN + "#start=45"]);
  assert.equal(sent[1][0].condition, "lv_customer_total > 1000");
  await dbg.stop();
});

test("a line SAP refuses is reported and not kept", async () => {
  const { dbg } = fakeSap();
  await assert.rejects(dbg.setBreakpoint({ name: "Z_CALC", line: 999 }), /Line 999 is not executable/);
  assert.equal(dbg.status().breakpoints.length, 0);
});

test("another debugger listening is not taken over silently", async () => {
  const { dbg } = fakeSap({ conflict: true });
  await assert.rejects(dbg.setBreakpoint({ name: "Z_CALC", line: 45 }), /Another debugger already listens for DEVELOPER: Eclipse of DEVELOPER/);
});

test("log breakpoints record and run on; a stop breakpoint waits; the end is reported", async () => {
  const { dbg, calls } = fakeSap({ stops: [
    { line: 45, vars: [simple("LV_TOTAL", "600.00"), table("LT_ORDERS", 2)] },
    { line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "900.00"), table("LT_ORDERS", 2)] },
    { line: 50, reached: "BP50", vars: [simple("LV_TOTAL", "900.00"), simple("LV_DISCOUNT", "70.00"), table("LT_ORDERS", 2)] }
  ] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45, mode: "log" });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 50 });
  const first = await dbg.wait(5);
  // Two passes of line 45 were logged without a turn of the assistant.
  assert.equal(first.logged.length, 2);
  assert.equal(first.logged[0].changed.LV_TOTAL, "600.00");
  assert.equal(first.logged[1].changed.LV_TOTAL, "900.00");
  // Line 50 stops, with only what changed since the last stop.
  assert.equal(first.stopped.at, "Z_CALC:50");
  assert.equal(first.stopped.breakpoint, "bp2");
  assert.deepEqual(first.stopped.changed, { LV_DISCOUNT: "70.00" });
  assert.match(first.stopped.source, /> 50 line 50/);
  // Continuing past the last stop ends the run.
  const last = await dbg.step("continue");
  assert.equal(last.finished[0].program, "Z_CALC");
  assert.ok(calls.includes("logout"));
  await dbg.stop();
});

test("a table that changed shows its first rows; debug_read reads a range", async () => {
  const { dbg } = fakeSap({ stops: [{ line: 23, vars: [table("LT_ORDERS", 3)] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 23 });
  const stop = await dbg.wait(5);
  assert.equal(stop.stopped.tables.LT_ORDERS.rows, 3);
  assert.equal(stop.stopped.tables.LT_ORDERS.shown.length, 3);
  const read = await dbg.read("lt_orders", 2, 3);
  assert.equal(read.from, 2);
  assert.equal(read.shown.length, 2);
  await dbg.stop();
});

test("a step that kills the run says whether it finished or dumped, and only for this user", async () => {
  const before = fakeDumps([
    // Already in ST22 when the run starts: this user's history, and somebody
    // else's dump of the same minute. Neither belongs to the run.
    { id: "old", author: "DEVELOPER", categories: [{ term: "MESSAGE_TYPE_X", label: "ABAP runtime error" }] },
    { id: "theirs", author: "OTHER", categories: [{ term: "SYNTAX_ERROR", label: "ABAP runtime error" }] }
  ]);
  const { dbg } = fakeSap({
    stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }],
    probe: before,
    dumpOnEnd: { id: "new",
      // The feed writes its summary as HTML, with SAP's own runtime-viewer
      // link inside it: the sentence is what a reader wants, the link is not.
      text: "<p>Syntax error in program ZCL_CALC_DATA_PROVIDER====CP.</p>"
        + "<p><a class=\"showInRuntimeViewerLink\" href=\"adt://A4H/sap/bc/adt/runtime/dumps/1\">Show in Runtime Error Viewer</a></p>",
      categories: [{ term: "SYNTAX_ERROR", label: "ABAP runtime error" }] }
  });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  const first = await dbg.wait(5);
  assert.equal(first.stopped.at, "Z_CALC:45");
  // The dumps that were there before the run are not this run's.
  assert.equal(first.dumps, undefined);

  // F5 into a class whose load fails: the step throws exactly as it throws
  // when the program simply ended, and ST22 is what tells them apart.
  const dead = await dbg.step("into");
  const run = dead.finished[0];
  assert.equal(run.program, "Z_CALC");
  assert.equal(run.dumped.length, 1);
  assert.equal(run.dumped[0].error, "SYNTAX_ERROR");
  assert.match(run.dumped[0].text, /ZCL_CALC_DATA_PROVIDER/);
  // The markup is taken off, and the link's own label is not read as part of
  // the message; SAP's address for the dump is kept apart from it.
  assert.doesNotMatch(run.dumped[0].text, /<|Runtime Error Viewer/);
  assert.equal(run.dumped[0].adt, "adt://A4H/sap/bc/adt/runtime/dumps/1");
  assert.match(run.note, /did not finish - it dumped/);
  // ST22's own table is read through the ABAP backend, which this fake SAP
  // does not serve. The dump is still reported; only the line it points at is
  // missing, and it says so rather than quietly having no place.
  assert.equal(run.dumped[0].where, undefined);
  assert.match(run.dumped[0].whyNoPlace, /could not be read/);
  await dbg.stop();
});

test("the last window closing on a stop lets the program go, and says so", async () => {
  // A stopped program holds the listener: nothing listens while a session is
  // attached, so breakpoints set afterwards are dead. A window closed on a
  // stop used to leave exactly that, with nothing on screen to say so.
  const { dbg, calls } = fakeSap({ stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  const unwatch = dbg.watch(function () {});
  const first = await dbg.wait(5);
  assert.equal(first.stopped.at, "Z_CALC:45");

  unwatch();
  // The release is not awaited by whoever closed the window, so give it its
  // turn before asking what became of the program.
  for (let n = 0; n < 50 && dbg.picture().stopped; n++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const news = await dbg.wait(5);
  assert.ok(calls.includes("logout"), "the stopped session was not let go");
  assert.equal(dbg.picture().stopped, null);
  assert.match(String(news.problems), /was stopped, so it was let go/);
  // The breakpoints stay: this is a release, not a stop.
  assert.equal(dbg.status().breakpoints.length, 1);
  await dbg.stop();
});

test("an assistant debugging with no window open keeps its stop", async () => {
  // Watchers are windows. One that never existed must not be counted as one
  // that went away, or the chat would lose the program it is standing in.
  const { dbg } = fakeSap({ stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  const first = await dbg.wait(5);
  assert.equal(first.stopped.at, "Z_CALC:45");
  const again = await dbg.wait(2);
  assert.equal(again.stopped.at, "Z_CALC:45");
  await dbg.stop();
});

test("Detach lets the program go unwatched, and ST22 answers when it is asked", async () => {
  // Detach continues the program and stops listening: no stop and no step is
  // ever coming, so nothing of ours can report how it ended. The reader asks.
  const feed = fakeDumps();
  const { dbg } = fakeSap({
    stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }],
    probe: feed
  });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);

  const started = Date.now();
  await dbg.detach();
  assert.ok(Date.now() - started < 1000, "Detach waited for a dump instead of answering");

  // The program, let go, dies a moment later.
  feed.push({ id: "afterDetach", text: "Syntax error in program ZCL_LATE." });
  const news = await dbg.checkDumps();
  assert.equal(news.found.length, 1);
  assert.equal(news.found[0].error, "SYNTAX_ERROR");
  assert.equal(news.program, "Z_CALC");
  // Asked again, the same dump is not news twice.
  assert.equal((await dbg.checkDumps()).found.length, 0);
  await dbg.stop();
});

test("a dump feed that never answers does not cost a stop", async () => {
  // The listener's long poll must go first and nothing may be awaited in
  // front of it: a breakpoint stops nothing while no listener waits, so a
  // slow ST22 read taken before it is a window in which the run is missed.
  const hangs = { dumps() { return new Promise(function () {}); } };
  const { dbg } = fakeSap({
    stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }],
    probe: hangs
  });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  const first = await dbg.wait(5);
  assert.equal(first.stopped.at, "Z_CALC:45");
  await dbg.stop();
});

test("a run that ends without a dump says so, and does not wait for one", async () => {
  const { dbg } = fakeSap({ stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  const started = Date.now();
  const dead = await dbg.step("continue");
  // A program that merely finished must not pay for the question: one ask of
  // the feed, no waiting for a dump that is not coming.
  assert.ok(Date.now() - started < 1000, "an ordinary end waited for a dump");
  assert.equal(dead.finished[0].dumped, undefined);
  assert.equal(dead.finished[0].note, "");
  await dbg.stop();
});

test("nothing is read or stepped without a stopped program", async () => {
  const { dbg } = fakeSap();
  await assert.rejects(dbg.read("LV_TOTAL"), /not stopped/);
  await assert.rejects(dbg.step("over"), /not stopped/);
});

test("a run opens WebGUI on the system, and needs a breakpoint first", async () => {
  const { dbg, opened } = fakeSap();
  await assert.rejects(dbg.run("Z_CALC"), /Set or activate a breakpoint/);
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.run("z_calc");
  assert.match(opened[0], /^https:\/\/sap\.example:44300\/sap\/bc\/gui\/sap\/its\/webgui\?~transaction=/);
  assert.match(decodeURIComponent(opened[0]), /RS38M-PROGRAMM=Z_CALC;DYNP_OKCODE=STRT/);
  assert.match(opened[0], /sap-client=100/);
  await dbg.stop();
});

test("stop removes every breakpoint and the listener", async () => {
  const { dbg, sent, calls } = fakeSap();
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.stop();
  assert.deepEqual(sent.at(-1), []);
  assert.ok(calls.includes("deleteListener"));
  assert.equal(dbg.status().listening, false);
});

test("a deactivated breakpoint stays in the list and leaves SAP; activated, it goes back", async () => {
  const { dbg, sent } = fakeSap();
  const bp = await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.activateBreakpoints(bp.id, false);
  assert.deepEqual(sent.at(-1), []);
  assert.equal(dbg.picture().breakpoints[0].active, false);
  assert.equal(dbg.status().breakpoints[0].inactive, true);
  await dbg.activateBreakpoints(undefined, true);
  assert.equal(sent.at(-1).length, 1);
  assert.equal(dbg.picture().breakpoints[0].active, true);
});

test("detach lets go and stops listening, but keeps the breakpoints for the next run", async () => {
  const { dbg, sent, calls } = fakeSap();
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.detach();
  assert.deepEqual(sent.at(-1), []);
  assert.ok(calls.includes("deleteListener"));
  assert.equal(dbg.status().listening, false);
  assert.equal(dbg.picture().breakpoints.length, 1);
});

test("the /debug set answers initialize with its instructions and lists only debug tools", async () => {
  const mcp = require("../mcp");
  const { dbg } = fakeSap();
  const set = mcp.debugSet(dbg);
  const init = await mcp.dispatch({}, { method: "initialize", params: {} }, set);
  assert.match(init.instructions, /debug_stop/);
  const list = await mcp.dispatch({}, { method: "tools/list" }, set);
  assert.ok(list.tools.every(t => t.name.startsWith("debug_")));
  // The review set keeps its own list and no instructions.
  const review = await mcp.dispatch({}, { method: "initialize", params: {} });
  assert.equal(review.instructions, undefined);
  const status = await mcp.dispatch({}, { method: "tools/call", params: { name: "debug_status", arguments: {} } }, set);
  assert.match(status.content[0].text, /"listening": false/);
  assert.match(dbg.status().answers, /^1 answers/);
});

test("the debugger follows the active system, and refuses to switch while debugging", async () => {
  let active = "QAS";
  const connected = [];
  const { dbg: probe } = fakeSap();
  const listener = { async debuggerSetBreakpoints(m, t, i, c, bps) { return bps.map(b => ({ id: "X", uri: { uri: b.split("#")[0], range: { start: { line: Number(b.split("=")[1]) } } } })); },
    async debuggerListeners() {}, async debuggerListen() { return new Promise(() => {}); }, async debuggerDeleteListener() {} };
  const dbg = create({ ideId: "I", terminalId: "T", openUrl: async () => {}, current: () => active,
    connect: async () => { connected.push(active); return { key: active, system: { name: active, url: "https://" + active.toLowerCase() }, user: "U", listener, probe: fakeDumps(), open: async () => ({}) }; } });
  assert.match(dbg.status().system, /not connected/);
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  active = "E19";
  await assert.rejects(dbg.setBreakpoint({ name: "Z_CALC", line: 50 }), /still going on QAS\. Call debug_stop first/);
  await dbg.stop();
  await dbg.setBreakpoint({ name: "Z_CALC", line: 50 });
  assert.deepEqual(connected, ["QAS", "E19"]);
  assert.match(dbg.status().system, /^E19/);
  await dbg.stop();
  await probe.stop();
});

test("a system's webgui address is where WebGUI opens; a bad one is refused", async () => {
  const opened = [];
  const listener = { async debuggerSetBreakpoints(m, t, i, c, bps) { return bps.map(b => ({ id: "X", uri: { uri: b.split("#")[0], range: { start: { line: Number(b.split("=")[1]) } } } })); },
    async debuggerListeners() {}, async debuggerListen() { return new Promise(() => {}); }, async debuggerDeleteListener() {} };
  let webgui = "https://10.0.0.5:44300/";
  const dbg = create({ ideId: "I", terminalId: "T", openUrl: async url => opened.push(url),
    connect: async () => ({ key: "DEV", system: { name: "DEV", url: "http://10.0.0.5:8000", client: "100", webgui }, user: "U", listener, probe: fakeDumps(), open: async () => ({}) }) });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.run("Z_CALC");
  assert.match(opened[0], /^https:\/\/10\.0\.0\.5:44300\/sap\/bc\/gui\/sap\/its\/webgui\?/);
  await dbg.stop();
  webgui = "ftp://nowhere";
  const bad = create({ ideId: "I", terminalId: "T", openUrl: async url => opened.push(url),
    connect: async () => ({ key: "DEV", system: { name: "DEV", url: "http://10.0.0.5:8000", webgui }, user: "U", listener, probe: fakeDumps(), open: async () => ({}) }) });
  await bad.setBreakpoint({ name: "Z_CALC", line: 45 });
  await assert.rejects(bad.run("Z_CALC"), /not an http\(s\) URL/);
  await bad.stop();
});

test("a quick step reads no variables, says how long it took, and still stops for the assistant", async () => {
  const { dbg, calls } = fakeSap({ stops: [
    { line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] },
    { line: 46, vars: [simple("LV_TOTAL", "700.00")] },
    { line: 47, vars: [simple("LV_TOTAL", "800.00")] }
  ] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  const before = calls.filter(c => c === "children").length;
  const timing = await dbg.advance("into", true);
  assert.equal(typeof timing.sap, "number");
  assert.ok(timing.total >= timing.sap);
  assert.equal(calls.filter(c => c === "children").length, before);
  assert.equal(dbg.picture().stopped.at, "Z_CALC:46");
  // The next ordinary stop reports the change against the last values read.
  await dbg.advance("over");
  const news = await dbg.wait(1);
  assert.deepEqual(news.stopped.changed, { LV_TOTAL: "800.00" });
  const read = await dbg.variables(["lv_total"]);
  assert.equal(read[0].value, "800.00");
  await dbg.stop();
});

test("a step gets its stack in the same request", async () => {
  const { dbg, calls } = fakeSap({ stops: [
    { line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] },
    { line: 46, vars: [simple("LV_TOTAL", "700.00")] }
  ] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  const from = calls.length;
  const timing = await dbg.advance("into", true);
  assert.deepEqual(calls.slice(from).filter(c => c === "batch" || c === "stack" || c === "stepInto"), ["batch", "stepInto"]);
  assert.equal(dbg.picture().stopped.at, "Z_CALC:46");
  assert.equal(typeof timing.queued, "number");
  await dbg.stop();
});

test("a step can read the followed value at the new stop in the same request", async () => {
  const { dbg, calls } = fakeSap({ stops: [
    { line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] },
    { line: 46, vars: [simple("LV_TOTAL", "700.00")] }
  ] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  const from = calls.length;
  const answer = await dbg.advance("into", true, ["lv_total"]);
  assert.deepEqual(calls.slice(from).filter(c => c === "batch" || c === "stack"), ["batch"]);
  assert.deepEqual(answer.values.names, ["LV_TOTAL"]);
  assert.equal(answer.values.read[0].value, "700.00");
  await dbg.stop();
});

test("a recorded stop's values come in two requests: every scope at once, then their structures' components", async () => {
  const { dbg, calls } = fakeSap({ stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00"),
    { ID: "LT_ORDERS[1]", NAME: "LS_ORDER", META_TYPE: "structure", VALUE: "" }] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  const from = calls.filter(c => c === "children").length;
  const { groups } = await dbg.stopValues(["globals"]);
  assert.equal(calls.filter(c => c === "children").length - from, 2);
  assert.deepEqual(groups.map(g => g.name), ["GLOBALS"]);
  assert.equal(groups[0].children.find(v => v.name === "LV_TOTAL").value, "600.00");
  assert.deepEqual(groups[0].children.find(v => v.name === "LS_ORDER").value, { CUSTOMER: "CUST_1" });
  assert.deepEqual((await dbg.stopValues(["locals"])).groups, [], "a scope not asked for is not read");
  await dbg.stop();
});

test("a step of Steps & values brings every scope with it; only a structure's components take a request more", async () => {
  const { dbg, calls } = fakeSap({ stops: [
    { line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] },
    { line: 46, vars: [simple("LV_TOTAL", "700.00"), { ID: "LT_ORDERS[1]", NAME: "LS_ORDER", META_TYPE: "structure", VALUE: "" }] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  const from = calls.length;
  const answer = await dbg.advance("into", true, null, ["params", "locals", "globals"]);
  assert.deepEqual(calls.slice(from).filter(c => c === "batch" || c === "children" || c === "stack"), ["batch", "children"]);
  const globals = answer.scopes.groups.find(g => g.name === "GLOBALS");
  assert.equal(globals.children.find(v => v.name === "LV_TOTAL").value, "700.00");
  assert.deepEqual(globals.children.find(v => v.name === "LS_ORDER").value, { CUSTOMER: "CUST_1" });
  await dbg.stop();
});

test("terminate ends the program and keeps the breakpoints and the listener", async () => {
  const { dbg, calls } = fakeSap({ stops: [{ line: 45, reached: "BP45", vars: [simple("LV_TOTAL", "600.00")] }] });
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.wait(5);
  await dbg.terminate();
  assert.ok(calls.includes("terminateDebuggee"));
  assert.equal(dbg.picture().stopped, null);
  assert.equal(dbg.picture().breakpoints.length, 1);
  const news = await dbg.wait(1);
  assert.match(news.finished[0].note, /Terminated/);
  await dbg.stop();
});

test("a function module or a class opens its test screen, with the name filled in", async () => {
  const { dbg, opened } = fakeSap();
  await dbg.setBreakpoint({ name: "Z_CALC", line: 45 });
  await dbg.run("z_fm", "FUNC");
  assert.match(decodeURIComponent(opened[0]), /~transaction=SE37 RS38L-NAME=Z_FM&/);
  await dbg.run("zcl_x", "CLAS");
  assert.match(decodeURIComponent(opened[1]), /~transaction=SE24 SEOCLASS-CLSNAME=ZCL_X&/);
  await assert.rejects(dbg.run("Z;DYNP_OKCODE=X"), /Not an object name/);
  await dbg.stop();
});

test("a class's method starts come from ADT's class structure, read once", async () => {
  let asked = 0;
  const listener = { async classComponents(url) { asked++; assert.equal(url, "/sap/bc/adt/oo/classes/zcl_x");
    return { "adtcore:name": "ZCL_X", "adtcore:type": "CLAS/OC", links: [], components: [
      { "adtcore:name": "run", "adtcore:type": "CLAS/OM/public", components: [], links: [
        { rel: "http://www.sap.com/adt/relations/source/definitionIdentifier", href: "/sap/bc/adt/oo/classes/zcl_x/source/main#start=12,10" },
        { rel: "http://www.sap.com/adt/relations/source/implementationIdentifier", href: "/sap/bc/adt/oo/classes/zcl_x/source/main#start=40,9" }] },
      { "adtcore:name": "mv_a", "adtcore:type": "CLAS/OA", components: [], links: [] }] }; } };
  const dbg = create({ ideId: "I", terminalId: "T", openUrl: async () => {},
    connect: async () => ({ key: "Q", system: { name: "Q", url: "https://q" }, user: "U", listener, probe: fakeDumps(), open: async () => ({}) }) });
  assert.deepEqual(await dbg.classMethods("/sap/bc/adt/oo/classes/zcl_x/source/main#start=41"), { RUN: 40 });
  await dbg.classMethods("/sap/bc/adt/oo/classes/zcl_x/source/main");
  assert.equal(asked, 1);
  // A record or an analysis asks again: the class may have been pulled with its methods moved.
  await dbg.classMethods("/sap/bc/adt/oo/classes/zcl_x/source/main", { fresh: true });
  assert.equal(asked, 2);
  await dbg.classMethods("/sap/bc/adt/oo/classes/zcl_x/source/main");
  assert.equal(asked, 2, "and what it found is kept again");
});
