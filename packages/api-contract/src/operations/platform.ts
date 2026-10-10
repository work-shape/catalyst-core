import { platformContextSchema } from "../platform";
import { defineOperation, json } from "./define-operation";

export const platformOperations = {
  "platform.context.get": defineOperation({
    id: "platform.context.get",
    method: "GET",
    path: "/api/v1/context",
    summary: "Read the instance, its release, the asset kinds and the caller's Namespaces",
    tag: "Platform",
    auth: "user",
    scope: "me:read",
    requires: [],
    effect: "reading",
    response: json(platformContextSchema),
    errors: [],
    rateClass: "read"
  })
} as const;
