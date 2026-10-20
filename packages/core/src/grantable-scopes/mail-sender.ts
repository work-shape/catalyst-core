import type { ActionScopes } from "./action-scopes";

export const MAIL_SENDER_GRANT_SCOPES = {
  // Sending as one sender of the instance (MAIL-1): granted on that one sender, `system`, and
  // never on all of them, so a later sender is not reached by a grant given for `system`. A
  // grant names a sender the instance registers, so none is written while outbound mail is off.
  "mail_sender.use": ["asset"]
} as const satisfies ActionScopes;
