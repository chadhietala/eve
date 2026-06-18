import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  // Manual smoke fixture only: give the remote TUI a stable fake user so the
  // interactive sandbox-authorization callback can exercise its full lifecycle.
  auth: () => ({
    attributes: {},
    authenticator: "sandbox-smoke",
    issuer: "sandbox-smoke",
    principalId: "sandbox-smoke-user",
    principalType: "user",
  }),
});
