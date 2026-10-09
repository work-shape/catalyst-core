import { z } from "zod";
import {
  apiCredentialSchema,
  createApiCredentialRequestSchema,
  createApiCredentialResponseSchema,
  createServicePrincipalRequestSchema,
  servicePrincipalDetailSchema,
  updateServicePrincipalRequestSchema
} from "../identity";
import { defineOperation, json } from "./define-operation";

export const apiAccessOperations = {
  listServicePrincipals: defineOperation({
    id: "listServicePrincipals",
    method: "GET",
    path: "/api/superadmin/api-access/service-principals",
    summary: "List service principals with their credentials",
    tag: "API Access",
    auth: "user",
    scope: "api_access:read",
    requires: ["api_access.manage"],
    effect: "reading",
    response: json(z.array(servicePrincipalDetailSchema)),
    errors: [],
    rateClass: "read"
  }),
  createServicePrincipal: defineOperation({
    id: "createServicePrincipal",
    method: "POST",
    path: "/api/superadmin/api-access/service-principals",
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
  updateServicePrincipal: defineOperation({
    id: "updateServicePrincipal",
    method: "PATCH",
    path: "/api/superadmin/api-access/service-principals/:servicePrincipalId",
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
  createApiCredential: defineOperation({
    id: "createApiCredential",
    method: "POST",
    path: "/api/superadmin/api-access/service-principals/:servicePrincipalId/credentials",
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
  revokeApiCredential: defineOperation({
    id: "revokeApiCredential",
    method: "POST",
    path: "/api/superadmin/api-access/credentials/:credentialId/revoke",
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
