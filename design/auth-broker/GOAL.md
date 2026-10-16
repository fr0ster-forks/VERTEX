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

## Landings

1. **First landing: `snc` and `basic`.**
   - SNC is the reason for the work.
   - Basic moves onto the broker in the same landing, with its stored passwords migrated, so there
     is one credential path from the start.
2. **Second landing: `jwt` and `saml`.**
   - `jwt` — OAuth authorization code against the system's UAA, for ABAP Cloud.
   - `saml` — both `saml2_pure` (SAML login yielding SAP session cookies) and `saml2_bearer`
     (SAML assertion exchanged for an OAuth token).

Each landing is complete on its own: its authentication types meet every criterion below.

## What success looks like

1. **Each system has an authentication type.** A system in `vertex.systems` states one, and
   VERTEX connects with it.
   - A system without a type is `basic`, so existing configurations keep working unchanged.
   - Each type uses the broker row it names:
     - `basic` — user and password;
     - `snc` — Secure Login Client through the connector's RFC transport;
     - `jwt` — `authorization_code`;
     - `saml` — `saml2_pure` or `saml2_bearer`.
   - VERTEX supplies the collaborators those rows need through the broker's existing ports:
     - browser authorization;
     - the SAML cookie exchange and assertion-replay store;
     - client authentication for `saml2_bearer`.
2. **Every VERTEX operation works whatever the authentication type of the landing.** The
   operations are:
   - repository browsing, search, source read and write;
   - lock and activation;
   - ABAP Unit, ATC and data preview;
   - the visual debugger: attach, step, stack, variables, detach and listener shutdown.

   The spec fixes the exact operation list and the platform matrix that prove it.
3. **Secrets live only in VS Code's SecretStorage.** That covers passwords, tokens, refresh tokens
   and session cookies. They are written through VERTEX's own implementation of the broker's
   store contracts, never in settings or files.
4. **Credentials are shared; SAP sessions are not.**
   - Within one window, all clients of a system share its credential and see a renewal:
     - the repository client;
     - the debugger's listener and probe;
     - every stopped-program client.
   - Across VS Code windows of the same profile, they share one stored login per system, and a
     refresh token renewed in one window is used by the others.
   - Each client keeps its own SAP session: cookies, CSRF token, and its stateful context or RFC
     conversation.
   - When several clients or windows need a renewal at once, it happens once.
   - A login prompt appears in one window. A cancelled login fails the waiting operations with a
     message, rather than prompting again in every window.
   - The spec defines what identifies a system's stored login.
5. **Renewal keeps the SAP session where the credential allows it, and says so where it cannot.**
   - **`jwt` and `saml2_bearer`:** an expired access token is renewed with the refresh token,
     without losing the SAP session. This holds for a lock window and for a debugger stop.
   - **`saml2_pure`:** there is no refresh grant. Renewal is a new SAML login with new SAP
     cookies, so the old SAP session ends.
   - **`snc`:** the logon happens when the RFC conversation opens, so there is nothing to renew.
   - **`basic`:** nothing to renew.
   - Whenever a SAP session ends under work in progress, VERTEX reports what was lost and does not
     silently start over. That includes a held lock and an attached debugger.
6. **Existing Basic users keep working without re-entering anything.**
   - A stored password is filed today under the system's name alone. It migrates once, at the
     upgrade, to the system that has that name then. That is the attribution VERTEX already makes.
   - When names collide, nothing migrates and VERTEX asks once.
   - From the migration on, a password belongs to the system's URL, client, type and user. Any
     later change to one of them asks.
   - A definition edited before the upgrade cannot be told apart from the original, because the
     old key records only the name. That limit is accepted.
7. **Unsupported hosts get a clear refusal, not a crash.**
   - `snc` runs only in a local extension host on Windows or macOS. On Linux, or in a remote
     extension host, selecting an `snc` system is refused with a message saying why. This happens
     before any native library is loaded or any connection is attempted.
   - `jwt` and `saml` run only in a local extension host for now. In a remote one they are refused
     the same way.
   - `basic` keeps working wherever it works today.
8. **The extension still packages and installs.**
   - Without SNC nothing native ships.
   - SNC ships as platform-specific VSIX packages. The spec names the supported Windows and macOS
     architectures.
   - The SAP NW RFC SDK is installed by the user, never shipped.

## Decided

- Keep `abap-adt-api` for the ADT operations (path a). Credentials come from the broker.
- SNC is RFC only, through `@mcp-abap-adt/connection` and `@mcp-abap-adt/sap-rfc-lite`, on
  Windows and macOS only. There is no HTTP form of SNC.
- The auth stack is not changed for VERTEX: no lock, no new port. VERTEX coordinates windows
  itself, outside the broker, through the ports the stack already has (stores, `renewal`).
- Dependencies come from the npm registry only, with no local links.
- VERTEX stays MIT. The auth stack's LGPL-3.0-only packages ship as separate, replaceable modules,
  with their notices.
- Remote extension hosts are out of scope for `jwt`, `saml` and `snc` for now.
- The standalone MCP in `mcp/` moves to the broker later, as separate work.

## Out of scope

- Replacing `abap-adt-api` with `@mcp-abap-adt/adt-clients`.
- Changes to the auth stack, the connector or `sap-rfc-lite`.
- The Eclipse plugin. It uses Eclipse ADT's own logon.
- The standalone MCP in `mcp/`.
- `jwt`, `saml` and `snc` in remote extension hosts (WSL, SSH, containers, Codespaces), and `snc`
  on Linux.

## Feasibility gates

These are measured before the spec commits to a design. Each one that fails is brought to the
owner with its options before work continues.

1. **SNC reaches the system.** The broker, the SNC provider and the RFC transport, run outside VS
   Code: provider, connect, discovery, source read, LOCK/UNLOCK (`probe/snc`).
2. **The extension host can run the stack.** Its Node version meets the auth stack's engines
   (22+), and `sap-rfc-lite` loads inside it. The minimum VS Code version follows from this.
3. **`abap-adt-api` runs over RFC without a CSRF token.** Its notion of "logged in" is the CSRF
   token SAP returns. Measure whether ADT over RFC returns one, and what the library then does on
   every request.
4. **The debugger listener can be stopped over RFC.** A native RFC call cannot be cancelled. Find
   out whether deleting the listener from another conversation ends the long poll, and how long
   shutdown takes. If the unchanged stack cannot stop it in bounded time, the owner decides the
   acceptable outcome.
