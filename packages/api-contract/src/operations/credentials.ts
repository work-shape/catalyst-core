import {
  exchangeApiKeyResponseSchema,
  issueSessionTokenRequestSchema,
  issueSessionTokenResponseSchema
} from "../identity";
import { defineOperation, json } from "./define-operation";

export const credentialOperations = {
  issueSessionToken: defineOperation({
    id: "issueSessionToken",
    method: "POST",
    path: "/api/superadmin/session-tokens",
    summary: "Issue a session token for a user of a trusted backend",
    tag: "Credentials",
    auth: "serverCredential",
    effect: "changing",
    body: issueSessionTokenRequestSchema,
    response: json(issueSessionTokenResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "auth"
  }),
  exchangeApiKey: defineOperation({
    id: "exchangeApiKey",
    method: "POST",
    path: "/api/auth/access-token",
    summary: "Exchange an API key for a short-lived access token",
    tag: "Credentials",
    auth: "public",
    effect: "changing",
    response: json(exchangeApiKeyResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "auth"
  }),
  issueSessionTokenLegacyAlias: defineOperation({
    id: "issueSessionTokenLegacyAlias",
    method: "POST",
    path: "/auth/session-token",
    summary: "Issue a session token at the path deployed integrations still call",
    tag: "Credentials",
    auth: "serverCredential",
    effect: "changing",
    body: issueSessionTokenRequestSchema,
    response: json(issueSessionTokenResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "auth"
  })
} as const;
