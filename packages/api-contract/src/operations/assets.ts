import {
  assetSchema,
  assetScopeQuerySchema,
  assetSummarySchema,
  assetWriteResponseSchema,
  deleteAssetRequestSchema,
  listAssetsQuerySchema,
  putAssetRequestSchema,
  revertAssetRequestSchema,
  syncAssetsRequestSchema,
  syncAssetsResponseSchema,
  validateAssetRequestSchema,
  validateAssetResponseSchema
} from "../assets";
import { configAssetRevisionSchema } from "../configuration";
import { listQuerySchema } from "../shared";
import { defineRegisteredOperation, json, page } from "./define-operation";

// Every operation here is one of the registry: a call is an Operation Run. None names its
// right in `requires`, because the right is the kind's own (`<kind>.read`, `<kind>.write`,
// `<kind>.delete`) and is decided on the asset the call names: a grant in a Namespace, on a
// workspace or on the asset itself can answer it. The registration brings that check.
export const assetOperations = {
  "assets.list": defineRegisteredOperation({
    id: "assets.list",
    method: "GET",
    path: "/api/v1/assets/:kind",
    summary: "List the assets of one kind the caller may read, by name",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: listQuerySchema.extend(listAssetsQuerySchema.shape),
    response: page(assetSummarySchema, ["name"], false),
    errors: [],
    rateClass: "read"
  }),
  "assets.sync": defineRegisteredOperation({
    id: "assets.sync",
    method: "POST",
    path: "/api/v1/assets/sync",
    summary: "Apply puts and deletes in one Namespace, all of them or none",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: syncAssetsRequestSchema,
    response: json(syncAssetsResponseSchema),
    errors: ["CONFLICT"],
    rateClass: "write"
  }),
  "assets.validate": defineRegisteredOperation({
    id: "assets.validate",
    method: "POST",
    path: "/api/v1/assets/:kind/validate",
    summary: "Check one definition against the instance without writing it",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    body: validateAssetRequestSchema,
    response: json(validateAssetResponseSchema),
    errors: [],
    rateClass: "read"
  }),
  "assets.get": defineRegisteredOperation({
    id: "assets.get",
    method: "GET",
    path: "/api/v1/assets/:kind/:name",
    summary: "Read one asset",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: assetScopeQuerySchema,
    response: json(assetSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  "assets.put": defineRegisteredOperation({
    id: "assets.put",
    method: "PUT",
    path: "/api/v1/assets/:kind/:name",
    summary: "Create one asset, or replace it at the revision the caller read",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: putAssetRequestSchema,
    response: json(assetWriteResponseSchema),
    errors: ["CONFLICT"],
    rateClass: "write"
  }),
  "assets.delete": defineRegisteredOperation({
    id: "assets.delete",
    method: "POST",
    path: "/api/v1/assets/:kind/:name/delete",
    summary: "Delete one asset and keep its revisions",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: deleteAssetRequestSchema,
    response: json(assetWriteResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  "assets.revisions.list": defineRegisteredOperation({
    id: "assets.revisions.list",
    method: "GET",
    path: "/api/v1/assets/:kind/:name/revisions",
    summary: "List the revisions of one asset",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: listQuerySchema.extend(assetScopeQuerySchema.shape),
    response: page(configAssetRevisionSchema, ["revision"], false),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  "assets.revert": defineRegisteredOperation({
    id: "assets.revert",
    method: "POST",
    path: "/api/v1/assets/:kind/:name/revert",
    summary: "Make an earlier revision the content of one asset again",
    tag: "Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: revertAssetRequestSchema,
    response: json(assetWriteResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  })
} as const;
