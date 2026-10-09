import { listQuerySchema } from "../shared";
import {
  apiCredentialSchema,
  createApiCredentialRequestSchema,
  createApiCredentialResponseSchema,
  createServicePrincipalRequestSchema,
  servicePrincipalDetailSchema,
  updateServicePrincipalRequestSchema
} from "../identity";
import { defineOperation, json, page } from "./define-operation";

export const apiAccessOperations = {
  "service_principals.list": defineOperation({
    id: "service_principals.list",
    method: "GET",
    path: "/api/v1/instance/service-principals",
    summary: "List service principals with their credentials",
    tag: "API Access",
    auth: "user",
    scope: "api_access:read",
    requires: ["api_access.manage"],
    effect: "reading",
    query: listQuerySchema,
    response: page(servicePrincipalDetailSchema, ["principal.displayLabel", "principal.id"], false),
    errors: [],
    rateClass: "read"
  }),
  "service_principals.create": defineOperation({
    id: "service_principals.create",
    method: "POST",
    path: "/api/v1/instance/service-principals",
    summary: "Create a service principal",
    tag: "API Access",
    auth: "user",
    scope: "api_access:write",
    requires: ["api_access.manage"],
    effect: "changing",
    body: createServicePrincipalRequestSchema,
    response: json(servicePrincipalDetailSchema),
    errors: [],
    rateClass: "write"
  }),
  "service_principals.update": defineOperation({
    id: "service_principals.update",
    method: "PATCH",
    path: "/api/v1/instance/service-principals/:servicePrincipalId",
    summary: "Change a service principal",
    tag: "API Access",
    auth: "user",
    scope: "api_access:write",
    requires: ["api_access.manage"],
    effect: "changing",
    body: updateServicePrincipalRequestSchema,
    response: json(servicePrincipalDetailSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  "api_credentials.create": defineOperation({
    id: "api_credentials.create",
    method: "POST",
    path: "/api/v1/instance/service-principals/:servicePrincipalId/credentials",
    summary: "Issue an API key for a service principal",
    tag: "API Access",
    auth: "user",
    scope: "api_access:write",
    requires: ["api_access.manage"],
    effect: "changing",
    body: createApiCredentialRequestSchema,
    response: json(createApiCredentialResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  "api_credentials.revoke": defineOperation({
    id: "api_credentials.revoke",
    method: "POST",
    path: "/api/v1/instance/api-credentials/:credentialId/revoke",
    summary: "Revoke an API key",
    tag: "API Access",
    auth: "user",
    scope: "api_access:write",
    requires: ["api_access.manage"],
    effect: "changing",
    response: json(apiCredentialSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  })
} as const;
