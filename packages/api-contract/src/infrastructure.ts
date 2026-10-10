import {
  PROVIDER_CHECK_ERROR_CLASSES,
  PROVIDER_PORTS,
  PROVIDER_REGIONS
} from "@vivd-catalyst/core";
import { z } from "zod";
import { timestampSchema } from "./shared";

/** What a row stands for: one of the provider ports, or the database of the instance. */
export const infrastructureClassSchema = z.enum([...PROVIDER_PORTS, "database"]);
export type InfrastructureClass = z.infer<typeof infrastructureClassSchema>;

/**
 * Who set a provider up. Today every one comes from the release config, which the operator
 * owns. `instance` is for a provider that an admin adds in the running product.
 */
export const infrastructureOriginSchema = z.enum(["operator", "instance"]);
export type InfrastructureOrigin = z.infer<typeof infrastructureOriginSchema>;

/** The last check of a provider. It carries a class of failure and never a provider's text. */
export const infrastructureCheckSchema = z.discriminatedUnion("status", [
  /** No check has ended since this process started. */
  z.object({ status: z.literal("pending") }),
  /** Another process holds the provider, so the API cannot ask it. */
  z.object({ status: z.literal("not_checked") }),
  z.object({ status: z.literal("ok"), checkedAt: timestampSchema }),
  z.object({
    status: z.literal("failed"),
    checkedAt: timestampSchema,
    errorClass: z.enum(PROVIDER_CHECK_ERROR_CLASSES)
  })
]);
export type InfrastructureCheck = z.infer<typeof infrastructureCheckSchema>;

/**
 * One thing the instance runs on, as an operator reads it. It holds the names of the secrets
 * and whether each is set: never a value, a connection string, a key or a path on the host.
 */
export const infrastructureProviderSchema = z.object({
  /** Where the entry sits in the release config, such as `models.azure-eu` or `mail`. */
  id: z.string(),
  class: infrastructureClassSchema,
  /** The name of the entry among several of its class: a model entry, `files`, `workspaces`. */
  name: z.string().optional(),
  /** The adapter that serves it, such as `openai-compatible`, `s3` or `postgres`. */
  type: z.string(),
  origin: infrastructureOriginSchema,
  /** True when data leaves the instance to reach it. It then states a region. */
  external: z.boolean(),
  region: z.enum(PROVIDER_REGIONS).optional(),
  /** The host the instance calls, without a path, a query or credentials. */
  endpointHost: z.string().optional(),
  bucket: z.string().optional(),
  secrets: z.array(z.object({ name: z.string(), state: z.enum(["set", "missing"]) })),
  check: infrastructureCheckSchema
});
export type InfrastructureProvider = z.infer<typeof infrastructureProviderSchema>;

export const infrastructureSchema = z.object({
  items: z.array(infrastructureProviderSchema),
  /** How often the instance checks its providers by itself. */
  checkIntervalSeconds: z.number().int().min(1),
  /** From when `instance.infrastructure.check` runs again. Absent when it would run now. */
  checkAvailableAt: timestampSchema.optional()
});
export type Infrastructure = z.infer<typeof infrastructureSchema>;
