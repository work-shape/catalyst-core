import { z } from "zod";
import { clientBrandingSchema, instanceModuleSchema, safeConfigSchema } from "../configuration";
import { defineOperation, json } from "./define-operation";

export const instanceOperations = {
  "branding.get": defineOperation({
    id: "branding.get",
    method: "GET",
    path: "/api/v1/instance/branding",
    summary: "Read the instance branding shown before sign-in",
    tag: "Instance",
    auth: "public",
    effect: "reading",
    query: z.object({ locale: z.string().optional() }),
    response: json(clientBrandingSchema),
    errors: [],
    rateClass: "read"
  }),
  "config.get": defineOperation({
    id: "config.get",
    method: "GET",
    path: "/api/v1/instance/config",
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
  }),
  // A plain read: the switch is release config, so there is nothing here to run or to audit.
  "instance.modules.list": defineOperation({
    id: "instance.modules.list",
    method: "GET",
    path: "/api/v1/instance/modules",
    summary: "List the modules of the product with their state on this instance",
    tag: "Instance",
    auth: "principal",
    scope: "governance:read",
    requires: ["audit.view"],
    effect: "reading",
    response: json(z.object({ items: z.array(instanceModuleSchema) })),
    errors: [],
    rateClass: "read"
  })
} as const;
