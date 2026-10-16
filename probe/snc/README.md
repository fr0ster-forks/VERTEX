# SNC probe

Development probe, not part of any shipped host. It answers one question before VERTEX takes a
dependency on the `@mcp-abap-adt` auth stack: does the auth broker, with its SNC provider and the
connector's RFC transport, reach a real SAP system from this machine?

## Prerequisites (Windows or macOS)

- Node 22, 24 or 26 (the auth stack's engines).
- SAP NW RFC SDK installed; its `lib` directory on `PATH` (Windows) or `DYLD_LIBRARY_PATH` (macOS),
  and `SAPNWRFC_HOME` set **during `npm install`** — `@mcp-abap-adt/sap-rfc-lite` is an optional
  native dependency and npm drops it silently when its build fails.
- Secure Login Client (or another SNC product) with a valid credential for the system.
- The user is authorized for RFC `SADT_REST_RFC_ENDPOINT`.

## Destination

`<dir>/<name>.env`, read by `EnvDestinationStore`:

```
SAP_AUTH_TYPE=snc
SAP_URL=http://<host>:80<NN>
SAP_CLIENT=<client>
SAP_SNC_PARTNERNAME=p:CN=<SID>, ...
# optional: SAP_SNC_QOP=9, SAP_SNC_LIB=<path>, SAP_SNC_MYNAME=p:CN=<user>
# optional: SAP_SYSNR=<NN> when the URL's port does not follow 80NN
```

An existing mcp-abap-adt destination for the same system can be used as is.

## Run

```
cd probe/snc
set SAPNWRFC_HOME=C:\nwrfcsdk\nwrfcsdk
set PATH=C:\nwrfcsdk\nwrfcsdk\lib;%PATH%
npm install
node probe.js --dir <destinations dir> --destination <name> --program <PROGRAM>
node probe.js --dir <destinations dir> --destination <name> --program <Z_PROGRAM> --lock
```

The report is JSON on stdout: the runtime, then each step with its outcome and duration. No
credential is printed. `--verbose` adds the connector's log on stderr.

## What it decides

| Step fails | Meaning |
|---|---|
| `getProvider` | the SNC library or product is not found or refused (the error names which) |
| `connect` | RFC/SNC logon refused, or the NW RFC SDK / binding is missing |
| `discovery` / `read source` | the RFC endpoint or authorization for it |
| `LOCK` / `UNLOCK` | stateful work over one RFC conversation |

Next probe, once this one is green: the same stack loaded inside the VS Code extension host
(Node version of the host, `sap-rfc-lite` loading under Electron).
