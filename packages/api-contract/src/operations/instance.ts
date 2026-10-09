import { z } from "zod";
import { clientBrandingSchema, safeConfigSchema } from "../configuration";
import { defineOperation, json } from "./define-operation";

export const instanceOperations = {
  getBranding: defineOperation({
    id: "getBranding",
    method: "GET",
    path: "/api/branding",
    summary: "Read the instance branding shown before sign-in",
    tag: "Instance",
    auth: "public",
    effect: "reading",
    query: z.object({ locale: z.string().optional() }),
    response: json(clientBrandingSchema),
    errors: [],
    rateClass: "read"
  }),
  getConfig: defineOperation({
    id: "getConfig",
    method: "GET",
    path: "/api/config",
    summary: "Read the instance configuration a member may see",
    tag: "Instance",
    auth: "user",
    scope: "config:read",
    requires: [],
    effect: "reading",
    query: z.object({ locale: z.string().optional() }),
    response: json(safeConfigSchema),
    errors: [],
    rateClass: "read"
  })
} as const;
