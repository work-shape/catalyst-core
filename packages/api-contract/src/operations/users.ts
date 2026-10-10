import { listQuerySchema } from "../shared";
import {
  administeredUserSchema,
  createAdministeredUserRequestSchema,
  resetAdministeredUserPasswordRequestSchema,
  resetAdministeredUserPasswordResponseSchema,
  sendAdministeredUserInvitationResponseSchema,
  updateAdministeredUserRequestSchema,
  upsertAdministeredUserIdentityRequestSchema
} from "../identity";
import { defineOperation, json, page } from "./define-operation";

export const userOperations = {
  "users.list": defineOperation({
    id: "users.list",
    method: "GET",
    path: "/api/v1/instance/users",
    summary: "List the users of the instance",
    tag: "Users",
    auth: "user",
    scope: "user_admin:read",
    requires: ["users.manage"],
    effect: "reading",
    query: listQuerySchema,
    response: page(administeredUserSchema, ["displayLabel", "id"], false),
    errors: [],
    rateClass: "read"
  }),
  "users.create": defineOperation({
    id: "users.create",
    method: "POST",
    path: "/api/v1/instance/users",
    summary: "Create a user",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    body: createAdministeredUserRequestSchema,
    response: json(administeredUserSchema),
    errors: ["CONFLICT"],
    rateClass: "write"
  }),
  "users.update": defineOperation({
    id: "users.update",
    method: "PATCH",
    path: "/api/v1/instance/users/:userId",
    summary: "Change a user's profile, roles or status",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    body: updateAdministeredUserRequestSchema,
    response: json(administeredUserSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  "users.delete": defineOperation({
    id: "users.delete",
    method: "DELETE",
    path: "/api/v1/instance/users/:userId",
    summary:
      "Delete a user and their data. Answers 202 when the user is closed and their data is still being removed.",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    response: json(administeredUserSchema),
    deferred: true,
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  "users.identities.upsert": defineOperation({
    id: "users.identities.upsert",
    method: "PUT",
    path: "/api/v1/instance/users/:userId/identities",
    summary: "Link a sign-in identity to a user",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    body: upsertAdministeredUserIdentityRequestSchema,
    response: json(administeredUserSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  "users.password.reset": defineOperation({
    id: "users.password.reset",
    method: "POST",
    path: "/api/v1/instance/users/:userId/password",
    summary: "Set a user's password",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    body: resetAdministeredUserPasswordRequestSchema,
    response: json(resetAdministeredUserPasswordResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  "users.invitation.send": defineOperation({
    id: "users.invitation.send",
    method: "POST",
    path: "/api/v1/instance/users/:userId/invitation",
    summary: "Mail a user a link to set their password",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    response: json(sendAdministeredUserInvitationResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  "users.identities.delete": defineOperation({
    id: "users.identities.delete",
    method: "DELETE",
    path: "/api/v1/instance/users/:userId/identities/:authSource/:externalUserId",
    summary: "Unlink a sign-in identity from a user",
    tag: "Users",
    auth: "user",
    scope: "user_admin:write",
    requires: ["users.manage"],
    effect: "changing",
    response: json(administeredUserSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  })
} as const;
