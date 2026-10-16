"use strict";
const BINDING = ["issuedFor", "issuedBy"];
function applySecret(current, write) {
  if (write.authorizationToken && write.sessionCookies) throw new Error("a write carries a token and cookies; a session holds one");
  const next = { ...current };
  const credentialGiven = write.authorizationToken !== undefined || write.sessionCookies !== undefined;
  if (credentialGiven) {
    if (write.authorizationToken) { next.authorizationToken = write.authorizationToken; delete next.sessionCookies; delete next.expiresAt; }
    else if (write.sessionCookies) { next.sessionCookies = write.sessionCookies; delete next.authorizationToken; delete next.expiresAt; }
    else {
      if (write.authorizationToken !== undefined) delete next.authorizationToken;
      if (write.sessionCookies !== undefined) delete next.sessionCookies;
      if (!next.authorizationToken && !next.sessionCookies) delete next.expiresAt;
    }
    if (write.expiresAt !== undefined && (next.authorizationToken || next.sessionCookies)) next.expiresAt = write.expiresAt;
  } else if (write.expiresAt !== undefined) { next.expiresAt = write.expiresAt; }
  if (write.refreshToken !== undefined) { if (write.refreshToken) next.refreshToken = write.refreshToken; else delete next.refreshToken; }
  const newCredential = !!(write.authorizationToken || write.sessionCookies);
  for (const f of BINDING) {
    if (newCredential || write[f] !== undefined) { if (write[f]) next[f] = write[f]; else delete next[f]; }
  }
  if (!next.authorizationToken && !next.sessionCookies) for (const f of BINDING) delete next[f];
  return next;
}
module.exports = { applySecret };
