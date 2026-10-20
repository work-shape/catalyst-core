import { defineModule } from "@work-shape/catalyst-core";

/** Inviting a user by an emailed link to set a password. */
export const userInvitationsModule = defineModule({
  name: "userInvitations",
  operations: ["users.invitation.send"],
  ui: ["settings.users.invitation"]
});
