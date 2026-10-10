import { platformContextSchema } from "../platform";
import { defineRegisteredOperation, json } from "./define-operation";

export const platformOperations = {
  // The first read of an outside editor, a service principal's included. It asks for no scope
  // of its own: the answer is cut to what the credential's scopes let its holder do.
  "platform.context.get": defineRegisteredOperation({
    id: "platform.context.get",
    method: "GET",
    path: "/api/v1/context",
    summary: "Read the instance, its release, the asset kinds and the caller's Namespaces",
    tag: "Platform",
    auth: "principal",
    scope: null,
    requires: [],
    effect: "reading",
    response: json(platformContextSchema),
    errors: [],
    rateClass: "read"
  })
} as const;
