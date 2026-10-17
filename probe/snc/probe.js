'use strict';
/**
 * SNC probe: can the @mcp-abap-adt auth broker and connector reach an SAP
 * system over RFC with SNC, the way VERTEX would use them?
 *
 * Steps, each timed and reported, never a credential printed:
 *   1. the runtime (Node, platform, arch) — the auth stack needs Node 22+
 *   2. broker.getProvider(destination) for an `snc` destination
 *   3. connect over RFC (SADT_REST_RFC_ENDPOINT)
 *   4. GET /sap/bc/adt/discovery
 *   5. GET the source of one program
 *   6. optional (--csrf): gate 3, CSRF on the library login request over RFC
 *   7. optional (--listener --user <ABAP user>): gate 4, listener deletion over RFC
 *   8. optional (--lock): LOCK then UNLOCK the program on the stateful conversation
 *
 * Usage:
 *   node probe.js --dir <destinations dir> --destination <name> --program <PROG> [--lock] [--csrf] [--listener --user <ABAP user>] [--verbose]
 *
 * <destinations dir>/<name>.env is read by EnvDestinationStore: SAP_AUTH_TYPE=snc,
 * SAP_URL, SAP_CLIENT, SAP_SNC_PARTNERNAME (required), SAP_SNC_QOP, SAP_SNC_LIB,
 * SAP_SNC_MYNAME. The RFC system number comes from the URL's port (80XX) or SAP_SYSNR.
 * The SAP NW RFC SDK's lib directory must be on PATH.
 */
const { AuthBroker } = require('@mcp-abap-adt/auth-broker');
const {
  EnvDestinationStore,
  SafeAbapSessionStore,
} = require('@mcp-abap-adt/auth-stores');
const { createConnection } = require('@mcp-abap-adt/connection');

function args(argv) {
  const out = { lock: false, csrf: false, listener: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lock') out.lock = true;
    else if (a === '--csrf') out.csrf = true;
    else if (a === '--listener') out.listener = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const opts = args(process.argv);
const report = { runtime: {}, steps: [] };
let watchdog = null;
const print = (done) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, done);

const logger = {
  debug: (m) => opts.verbose && process.stderr.write(`[debug] ${m}\n`),
  info: (m) => opts.verbose && process.stderr.write(`[info] ${m}\n`),
  warn: (m) => process.stderr.write(`[warn] ${m}\n`),
  error: (m) => process.stderr.write(`[error] ${m}\n`),
};

/** Records a step's outcome; a failure keeps the error's name, message and SAP status, never a secret. */
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - started, ...detail });
    return true;
  } catch (e) {
    report.steps.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: {
        name: e && e.name,
        message: e && e.message,
        status: e && e.response && e.response.status,
        body: e && e.response && String(e.response.data || '').slice(0, 2000),
      },
    });
    return false;
  }
}

async function main() {
  watchdog = setTimeout(() => { report.fatal = { name: 'Watchdog', message: 'the probe did not finish within 6 minutes' }; print(() => process.exit(3)); }, 360000);
  report.runtime = {
    node: process.versions.node,
    napi: process.versions.napi,
    platform: process.platform,
    arch: process.arch,
    sapnwrfcHome: Boolean(process.env.SAPNWRFC_HOME),
  };
  for (const required of ['dir', 'destination', 'program']) {
    if (!opts[required]) throw new Error(`--${required} is required`);
  }
  const program = opts.program.toUpperCase();
  if (opts.lock && !/^[ZY]/.test(program)) {
    throw new Error('--lock only on a Z/Y program');
  }

  const broker = new AuthBroker(
    {
      sessionStore: new SafeAbapSessionStore(),
      serviceKeyStore: new EnvDestinationStore(opts.dir),
    },
    logger,
  );

  let means;
  let credential;
  if (
    !(await step('destination', async () => {
      means = await broker.getConnectionConfig(opts.destination);
      if (!means) throw new Error('destination not found');
      return {
        authType: means.authType,
        serviceUrl: means.serviceUrl,
        sapClient: means.sapClient,
        sncQop: means.sncQop,
        sncLibStated: Boolean(means.sncLib),
      };
    }))
  )
    return;
  if (
    !(await step('getProvider', async () => {
      credential = await broker.getProvider(opts.destination);
      return { provider: credential && credential.constructor && credential.constructor.name };
    }))
  )
    return;

  const connection = createConnection({
    system: 'onprem',
    transport: 'rfc',
    config: {
      url: means.serviceUrl,
      client: means.sapClient,
      authType: 'snc',
      sncPartnerName: means.sncPartnerName,
      sncQop: means.sncQop,
      sncLib: means.sncLib,
      sncMyName: means.sncMyName,
    },
    credential,
    logger,
  });

  try {
    if (!(await step('connect', async () => { await connection.connect(); return {}; }))) return;

    await step('discovery', async () => {
      const r = await connection.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 60000,
        headers: { Accept: 'application/atomsvc+xml' },
      });
      return { status: r.status, bytes: String(r.data || '').length };
    });

    const programUrl = `/sap/bc/adt/programs/programs/${encodeURIComponent(program.toLowerCase())}`;
    await step('read source', async () => {
      const r = await connection.makeAdtRequest({
        url: `${programUrl}/source/main`,
        method: 'GET',
        timeout: 60000,
        headers: { Accept: 'text/plain' },
      });
      return { status: r.status, lines: String(r.data || '').split('\n').length };
    });

    if (opts.csrf) {
      // Gate 3 measures what abap-adt-api's login sends: GET compatibility/graph with x-csrf-token: fetch.
      await step('csrf on the library login request over RFC', async () => {
        const r = await connection.makeAdtRequest({
          url: '/sap/bc/adt/compatibility/graph', method: 'GET', timeout: 60000,
          headers: { 'x-csrf-token': 'fetch' },
        });
        const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        const token = h['x-csrf-token'];
        return { status: r.status, csrfHeaderPresent: token !== undefined,
          csrfValueKind: token === undefined ? 'absent' : /^(fetch|required)$/i.test(String(token)) ? String(token) : 'token-like' };
      });
    }
    if (opts.listener) {
      // Gate 4: the listener long-poll exactly as abap-adt-api sends it (api/debugger.js:135-150:
      // POST with debuggingMode, requestUser, terminalId, ideId, checkConflict, isNotifiedOnConflict,
      // no server timeout), deleted from a second connection as abap-adt-api deletes it (:151-160).
      const user = String(opts.user || '').toUpperCase();
      if (!user) throw new Error('--listener needs --user <ABAP user>');
      const ide = 'VERTEXPROBE' + Date.now().toString(16).toUpperCase();
      const q = `debuggingMode=user&requestUser=${user}&terminalId=${ide}&ideId=${ide}`;
      const second = createConnection({ system: 'onprem', transport: 'rfc', config: {
        url: means.serviceUrl, client: means.sapClient, authType: 'snc', sncPartnerName: means.sncPartnerName,
        sncQop: means.sncQop, sncLib: means.sncLib, sncMyName: means.sncMyName }, credential, logger });
      await second.connect();
      const started = Date.now();
      let pollEndedAt = null, deletedAt = null, deleteOk = false;
      const poll = connection.makeAdtRequest({ url: `/sap/bc/adt/debugger/listeners?${q}&checkConflict=true&isNotifiedOnConflict=true`,
        method: 'POST', timeout: 360000000 })
        .then(r => ({ outcome: 'answered', status: r.status }), e => ({ outcome: 'failed', error: e && e.message, status: e && e.response && e.response.status }))
        .then(x => { pollEndedAt = Date.now(); return x; });
      await new Promise(r => setTimeout(r, 5000));
      const endedBeforeDelete = pollEndedAt !== null;
      await step('delete listener from second connection', async () => {
        deletedAt = Date.now();
        const r = await second.makeAdtRequest({ url: `/sap/bc/adt/debugger/listeners?${q}&checkConflict=false&notifyConflict=true`, method: 'DELETE', timeout: 60000 });
        deleteOk = r.status >= 200 && r.status < 300;
        return { status: r.status };
      });
      // Bounded wait: RFC ignores request timeouts (RfcTransport.ts:607). 60 s after the deletion.
      let timer;
      const settled = await Promise.race([poll, new Promise(r => { timer = setTimeout(() => r({ outcome: 'still-pending-60s-after-delete' }), 60000); })]);
      clearTimeout(timer);
      const secondsAfterDelete = pollEndedAt && deletedAt ? (pollEndedAt - deletedAt) / 1000 : null;
      // Ended by the deletion: the deletion succeeded, the poll had not ended before it, and it ended within 30 s of it.
      const endedByDelete = deleteOk && !endedBeforeDelete && secondsAfterDelete !== null && secondsAfterDelete >= 0 && secondsAfterDelete <= 30;
      report.steps.push({ name: 'listener poll after deletion', ok: endedByDelete, deleteOk,
        endedBeforeDelete, secondsAfterDelete, totalSeconds: (Date.now() - started) / 1000, ...settled });
      // Do not await native close behind a poll that may still hold the client mutex; the watchdog ends the process.
      second.disconnect().catch(() => {});
      if (settled.outcome === 'still-pending-60s-after-delete') report.listenerLeftPending = true;
    }

    if (opts.lock) {
      let handle = '';
      connection.setSessionType('stateful');
      try {
        await step('LOCK', async () => {
          const r = await connection.makeAdtRequest({
            url: `${programUrl}?_action=LOCK&accessMode=MODIFY`,
            method: 'POST',
            timeout: 60000,
            headers: {
              Accept:
                'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
            },
          });
          handle = (/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/.exec(String(r.data)) || [])[1] || '';
          return { status: r.status, handleReceived: Boolean(handle) };
        });
        if (handle) {
          await step('UNLOCK', async () => {
            const r = await connection.makeAdtRequest({
              url: `${programUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
              method: 'POST',
              timeout: 60000,
            });
            return { status: r.status };
          });
        }
      } finally {
        connection.setSessionType('stateless');
      }
    }
  } finally {
    if (!report.listenerLeftPending) {
      await step('disconnect', async () => { await connection.disconnect(); return {}; });
    }
  }
}

main()
  .catch((e) => {
    report.fatal = { name: e && e.name, message: e && e.message };
    process.exitCode = 1;
  })
  .finally(() => {
    if (watchdog) clearTimeout(watchdog);
    if (report.listenerLeftPending) print(() => process.exit(0));
    else print();
  });
