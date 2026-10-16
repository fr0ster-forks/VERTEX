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
 *   6. optional (--lock): LOCK then UNLOCK the program on the stateful conversation
 *
 * Usage:
 *   node probe.js --dir <destinations dir> --destination <name> --program <PROG> [--lock] [--verbose]
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
  const out = { lock: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lock') out.lock = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const opts = args(process.argv);
const report = { runtime: {}, steps: [] };
const print = () => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

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
    await step('disconnect', async () => { await connection.disconnect(); return {}; });
  }
}

main()
  .catch((e) => {
    report.fatal = { name: e && e.name, message: e && e.message };
    process.exitCode = 1;
  })
  .finally(print);
