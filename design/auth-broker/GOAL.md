# Goal: VERTEX connects through the @mcp-abap-adt auth stack

## Why

Today the VS Code extension authenticates with HTTP Basic only. The user and password come from
`vertex.systems` and `context.secrets`. That leaves out systems that cannot or must not be
reached with a password:

- ABAP Cloud (BTP), which takes an OAuth token;
- systems behind SAML single sign-on;
- on-premise systems where the logon is SNC through Secure Login Client.

The `@mcp-abap-adt` auth stack already covers these credentials:

- `@mcp-abap-adt/auth-broker` composes them;
- `@mcp-abap-adt/auth-providers` provides the flows;
- `@mcp-abap-adt/auth-stores` and the `interfaces-auth*` contracts provide the stores;
- `@mcp-abap-adt/connection` provides the RFC wire SNC needs.

VERTEX should use that stack instead of growing its own.

## What success looks like

1. **Each system has an authentication type.** A system in `vertex.systems` states one, and
   VERTEX connects with it:
   - `basic` — user and password, as today, now through the broker;
   - `jwt` — OAuth authorization code against the system's UAA, for ABAP Cloud;
   - `saml` — SAML session cookies;
   - `snc` — Secure Login Client over RFC, on Windows and macOS.
2. **Everything VERTEX does works the same whatever the authentication type:**
   - repository browsing, search, source read and write;
   - lock, activation, ABAP Unit, ATC and data preview;
   - the visual debugger.
3. **Secrets live only in VS Code's SecretStorage.** That covers passwords, tokens, refresh tokens
   and session cookies. They are written through VERTEX's own implementation of the broker's
   store contracts, and never in settings or files.
4. **Several VS Code windows share one login per system.** A token renewed in one window is used by
   the others. A login prompt appears in one window, not in every window.
5. **A credential that expires mid-work is renewed without losing the SAP session.** This holds for
   a lock window and for a debugger stop. If SAP itself ends the session, VERTEX says so instead of
   silently starting over.
6. **Existing Basic users keep working without re-entering anything.** Their stored passwords
   migrate.
7. **The extension still packages and installs.** HTTP authentication types need nothing native.
   SNC ships as platform-specific VSIX packages for Windows and macOS. The SAP NW RFC SDK is
   installed by the user, never shipped.

## Decided

- Keep `abap-adt-api` for the ADT operations (path a). Credentials come from the broker.
- SNC is RFC only, through `@mcp-abap-adt/connection` and `@mcp-abap-adt/sap-rfc-lite`, on
  Windows and macOS only. There is no HTTP form of SNC.
- The auth stack is not changed for VERTEX: no lock, no new port. VERTEX coordinates windows
  itself, outside the broker, through the ports the stack already has (stores, `renewal`).
- Dependencies come from the npm registry only, with no local links.
- VERTEX stays MIT. The auth stack's LGPL-3.0-only packages ship as separate, replaceable modules,
  with their notices.

## Out of scope

- Replacing `abap-adt-api` with `@mcp-abap-adt/adt-clients`.
- Changes to the auth stack, the connector or `sap-rfc-lite`.
- The Eclipse plugin. It uses Eclipse ADT's own logon.
- SNC on Linux and on remote extension hosts (WSL, SSH, containers, Codespaces).

## Open

- Does the standalone MCP in `mcp/` move to the broker in the same work, or later?
- Which authentication types come first? SNC is the priority. Do `jwt` and `saml` follow in the
  same landing or later?
- The minimum VS Code version. It follows from the Node version the auth stack needs (22+), once
  that is measured in the extension host.
