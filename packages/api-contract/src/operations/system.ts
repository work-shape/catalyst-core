import { listQuerySchema } from "../shared";
import { capturedMailSchema, healthSchema } from "../system";
import { blob, defineOperation, json, page } from "./define-operation";

export const systemOperations = {
  getHealth: defineOperation({
    id: "getHealth",
    method: "GET",
    path: "/health",
    summary: "Report that the instance answers",
    tag: "System",
    auth: "public",
    effect: "reading",
    response: json(healthSchema),
    errors: [],
    rateClass: "read"
  }),
  // Outside `/api`: a script address inside a sandboxed frame, called without credentials and
  // never changed under a version. APP-1 serves the App Kit from the same path family.
  getViewRuntimeFile: defineOperation({
    id: "getViewRuntimeFile",
    method: "GET",
    path: "/app-runtime/view/:version/:file",
    summary: "Serve one pinned file of the runtime a generated view loads",
    tag: "System",
    auth: "public",
    effect: "reading",
    response: blob(),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  listCapturedMail: defineOperation({
    id: "listCapturedMail",
    method: "GET",
    path: "/api/dev/captured-mail",
    summary: "List the mails a development instance captured instead of sending",
    tag: "System",
    auth: "public",
    effect: "reading",
    query: listQuerySchema,
    response: page(capturedMailSchema, ["sentAt", "id"], true),
    errors: [],
    rateClass: "read",
    devOnly: true
  })
} as const;
