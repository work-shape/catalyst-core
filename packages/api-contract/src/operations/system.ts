import { z } from "zod";
import { capturedMailSchema, healthSchema } from "../system";
import { defineOperation, json } from "./define-operation";

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
  listCapturedMail: defineOperation({
    id: "listCapturedMail",
    method: "GET",
    path: "/api/dev/captured-mail",
    summary: "List the mails a development instance captured instead of sending",
    tag: "System",
    auth: "public",
    effect: "reading",
    response: json(z.array(capturedMailSchema)),
    errors: [],
    rateClass: "read",
    devOnly: true
  })
} as const;
