"use strict";
const { AuthBroker } = require("@mcp-abap-adt/auth-broker");
const { loginIdentity } = require("./systems");
function createBroker({ serviceKeyStore, sessionStore, logger }) {
  const broker = new AuthBroker({ sessionStore, serviceKeyStore }, logger);
  return { providerFor: (system, signal) => broker.getProvider(loginIdentity(system), signal ? { signal } : undefined) };
}
module.exports = { createBroker };
