import {
  appPreviewRequestSchema,
  appPreviewSchema,
  createAppFromPageRequestSchema,
  createAppFromPageResponseSchema
} from "../apps";
import { defineOperation, defineRegisteredOperation, json } from "./define-operation";

// What an App has beside the operations of every asset (`assets.put`, `assets.publish`,
// `assets.discard_draft`, `assets.delete` with the kind `app`): it is made from a Page, and
// its revisions are opened by people. The rights are the kind's own, decided on the App's
// workspace, so neither operation names one in `requires`.
export const appOperations = {
  "apps.create_from_page": defineRegisteredOperation({
    id: "apps.create_from_page",
    method: "POST",
    path: "/api/v1/apps",
    summary: "Save the newest revision of a Page as an App with a draft",
    tag: "Apps",
    auth: "user",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: createAppFromPageRequestSchema,
    response: json(createAppFromPageResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  // POST although it changes nothing: its answer is a credential and is never cached.
  "apps.preview": defineOperation({
    id: "apps.preview",
    method: "POST",
    path: "/api/v1/apps/:app/preview",
    summary: "Get the address a frame loads the published or the draft revision of an App from",
    tag: "Apps",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    body: appPreviewRequestSchema,
    response: json(appPreviewSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  })
} as const;
