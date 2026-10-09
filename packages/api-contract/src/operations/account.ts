import { z } from "zod";
import { userModelPreferenceSchema } from "../configuration";
import {
  apiUserSchema,
  changeCurrentUserPasswordRequestSchema,
  changeCurrentUserPasswordResponseSchema,
  completePasswordSetupRequestSchema,
  completePasswordSetupResponseSchema,
  deleteCurrentUserResponseSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  updateCurrentUserRequestSchema
} from "../identity";
import { defineOperation, json } from "./define-operation";

export const accountOperations = {
  getCurrentUser: defineOperation({
    id: "getCurrentUser",
    method: "GET",
    path: "/api/me",
    summary: "Read the signed-in user with effective permissions",
    tag: "Account",
    auth: "user",
    scope: "me:read",
    requires: [],
    effect: "reading",
    response: json(apiUserSchema),
    errors: [],
    rateClass: "read"
  }),
  updateCurrentUser: defineOperation({
    id: "updateCurrentUser",
    method: "PATCH",
    path: "/api/me",
    summary: "Change the signed-in user's profile",
    tag: "Account",
    auth: "user",
    scope: "me:write",
    requires: [],
    effect: "changing",
    body: updateCurrentUserRequestSchema,
    response: json(apiUserSchema),
    errors: [],
    rateClass: "write"
  }),
  getCurrentUserModelPreference: defineOperation({
    id: "getCurrentUserModelPreference",
    method: "GET",
    path: "/api/me/model-preference",
    summary: "Read the signed-in user's model preference",
    tag: "Account",
    auth: "user",
    scope: "me:read",
    requires: [],
    effect: "reading",
    response: json(userModelPreferenceSchema),
    errors: [],
    rateClass: "read"
  }),
  setCurrentUserModelPreference: defineOperation({
    id: "setCurrentUserModelPreference",
    method: "PUT",
    path: "/api/me/model-preference",
    summary: "Replace the signed-in user's model preference",
    tag: "Account",
    auth: "user",
    scope: "me:write",
    requires: [],
    effect: "changing",
    body: userModelPreferenceSchema,
    response: json(userModelPreferenceSchema),
    errors: [],
    rateClass: "write"
  }),
  changeCurrentUserPassword: defineOperation({
    id: "changeCurrentUserPassword",
    method: "POST",
    path: "/api/me/password",
    summary: "Change the signed-in user's password",
    tag: "Account",
    auth: "user",
    scope: "me:write",
    requires: [],
    effect: "changing",
    body: changeCurrentUserPasswordRequestSchema,
    response: json(changeCurrentUserPasswordResponseSchema),
    errors: [],
    rateClass: "auth"
  }),
  deleteCurrentUser: defineOperation({
    id: "deleteCurrentUser",
    method: "DELETE",
    path: "/api/me",
    summary: "Delete the signed-in user's account and data",
    tag: "Account",
    auth: "user",
    scope: "me:delete",
    requires: [],
    effect: "changing",
    response: json(deleteCurrentUserResponseSchema),
    errors: [],
    rateClass: "write"
  }),
  requestPasswordReset: defineOperation({
    id: "requestPasswordReset",
    method: "POST",
    path: "/api/password-reset",
    summary: "Send a password reset mail to a locked-out user",
    tag: "Account",
    auth: "public",
    effect: "changing",
    query: z.object({ locale: z.string().optional() }),
    body: requestPasswordResetRequestSchema,
    response: json(requestPasswordResetResponseSchema),
    errors: [],
    rateClass: "auth"
  }),
  completePasswordSetup: defineOperation({
    id: "completePasswordSetup",
    method: "POST",
    path: "/api/password-setup",
    summary: "Set a password with a setup or reset token",
    tag: "Account",
    auth: "public",
    effect: "changing",
    body: completePasswordSetupRequestSchema,
    response: json(completePasswordSetupResponseSchema),
    errors: [],
    rateClass: "auth"
  })
} as const;
