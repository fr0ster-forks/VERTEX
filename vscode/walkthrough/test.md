# Test the connection

**Test SAP Systems** logs on to every configured system and says, per system, what is wrong: no answer at that address, a certificate that cannot be verified, a refused logon, or ADT services not active.

For `basic`, logon uses your SAP user and password. The password is asked once per system and kept in the operating system's credential store through VS Code SecretStorage - never in settings. A refused password is discarded, so the next test asks again. **VERTEX: Forget Credentials** clears the active system's stored credentials.

For `snc`, Secure Login Client supplies the logon without a password prompt.
