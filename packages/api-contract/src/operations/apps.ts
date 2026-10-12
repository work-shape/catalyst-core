import {
  appActionCallRequestSchema,
  appActionCallResultSchema,
  appActionsListQuerySchema,
  appActionsSchema,
  appConnectionCallRequestSchema,
  appFromPageQuerySchema,
  appFromPageSchema,
  appPreviewRequestSchema,
  appSessionContextRequestSchema,
  appSessionContextSchema,
  appPreviewSchema,
  createAppFromPageRequestSchema,
  createAppFromPageResponseSchema,
  updateAppFromPageRequestSchema
} from "../apps";
import { defineOperation, defineRegisteredOperation, json } from "./define-operation";

/**
 * What a call of a frame declares. It runs through the call path as the operation its action
 * is (`app.<id>.<action>` in an App, `page_action.<page id>.<action>` in a Page of a
 * conversation, or the Connection's own), so every call is an Operation Run with
 * the origin `app`. The name of that operation is read from the manifest the frame shows and
 * is not this descriptor's id, which is why these are not defined with
 * `defineRegisteredOperation`. A call that waits for an approval answers `200` with the
 * status `pending_approval`: the frame reads one shape.
 */
const FRAME_CALL = {
  method: "POST",
  tag: "Apps",
  auth: "user",
  scope: "conversation:write",
  requires: [],
  effect: "changing",
  headers: {
    request: ["Idempotency-Key"],
    response: ["Operation-Run-Id", "Idempotent-Replayed"]
  },
  response: json(appActionCallResultSchema),
  errors: [
    "NOT_FOUND",
    "CONFLICT",
    "TIMEOUT",
    "POLICY_DENIED",
    "GUARDRAIL_BLOCKED",
    "IDEMPOTENCY_KEY_REUSED",
    "OPERATION_IN_PROGRESS",
    "OPERATION_EXPIRED",
    "OUTPUT_NOT_RETAINED"
  ],
  rateClass: "write"
} as const;

// What an App has beside the operations of every asset (`assets.put`, `assets.publish`,
// `assets.discard_draft`, `assets.delete` with the kind `app`): it is made from a Page, and
// its draft is written from that Page again, and its revisions are opened by people. The rights
// are the kind's own, decided on the App's workspace, so no operation names one in `requires`.
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
  "apps.update_from_page": defineRegisteredOperation({
    id: "apps.update_from_page",
    method: "POST",
    path: "/api/v1/apps/:app/update-from-page",
    summary:
      "Write the newest revision of a Page as a new draft revision of the App that is updated from it",
    tag: "Apps",
    auth: "user",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: updateAppFromPageRequestSchema,
    response: json(createAppFromPageResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT", "REVISION_CONFLICT", "VALIDATION_FAILED"],
    rateClass: "write"
  }),
  "apps.get_from_page": defineOperation({
    id: "apps.get_from_page",
    method: "GET",
    path: "/api/v1/conversations/:conversationId/pages/:pageId/app",
    summary: "Read the App a Page is updated into, where the caller may write it",
    tag: "Apps",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    query: appFromPageQuerySchema,
    response: json(appFromPageSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
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
  }),
  // POST because it carries the token of the frame's address, which never stands in a path.
  "apps.sessions.context": defineOperation({
    id: "apps.sessions.context",
    method: "POST",
    path: "/api/v1/app-content-sessions/:pageSessionId/context",
    summary: "Read what each action of the Page or App a frame shows would come to for the caller",
    tag: "Apps",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    body: appSessionContextRequestSchema,
    response: json(appSessionContextSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  // A path of its own: `actions` beside `/apps/:app` would read an App named `actions`. The
  // right is `app.read` on each App, decided where the answer is built: on the App the call
  // names, and per App where it names none.
  "apps.actions.list": defineRegisteredOperation({
    id: "apps.actions.list",
    method: "GET",
    path: "/api/v1/app-actions",
    summary:
      "List the named actions of one App or of every published App the caller reads, with what a call of each would come to for the caller",
    tag: "Apps",
    auth: "user",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: appActionsListQuerySchema,
    response: json(appActionsSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  "apps.sessions.call_action": defineOperation({
    ...FRAME_CALL,
    id: "apps.sessions.call_action",
    path: "/api/v1/app-content-sessions/:pageSessionId/actions/:name",
    summary: "Call a named action of the Page or App a frame shows, with the caller's rights",
    body: appActionCallRequestSchema
  }),
  "apps.sessions.call_connection": defineOperation({
    ...FRAME_CALL,
    id: "apps.sessions.call_connection",
    path: "/api/v1/app-content-sessions/:pageSessionId/connections/:connection/operations/:operation",
    summary:
      "Call an operation of a Connection the manifest of the shown Page or App lists, with the caller's rights",
    body: appConnectionCallRequestSchema
  })
} as const;
