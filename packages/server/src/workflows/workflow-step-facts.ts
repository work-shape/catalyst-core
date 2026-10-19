import type { Asset } from "@work-shape/catalyst-api-contract";
import { workflowStepsDeep, type ActorAccess, type JsonObject } from "@work-shape/catalyst-core";
import { z } from "zod";
import { getModelProviderConfigs } from "@work-shape/catalyst-config-schema";
import { jsonSchemaOf } from "../platform/platform-callable-operations";
import { operationTarget, workflowFacts } from "../publish-narrative/narrative-facts";
import { accessResource } from "../assets/asset-access";
import type { AssetWorkflowOptions } from "../types";

type StepFacts = NonNullable<Asset["stepFacts"]>;
type OperationFact = NonNullable<StepFacts[string]["tools"]>[number];
const manifestSchema = z.object({ manifest: z.object({ steps: z.unknown() }) });
const sourceConfigSchema = z.object({
  title: z.string().optional(),
  displayName: z.string().optional(),
  service: z.string().optional(),
  manifest: z.object({ name: z.string().optional() }).optional()
});

/** The revision's named sources are resolved once, and never disclose an unreadable source. */
export async function workflowStepFacts(
  options: AssetWorkflowOptions,
  config: JsonObject,
  name: string,
  access: ActorAccess,
  schedule: { timeZone: string; nextDueAt?: string }
): Promise<StepFacts> {
  const declared = workflowFacts(config, name);
  const manifest = manifestSchema.safeParse(config).data?.manifest;
  if (!declared || !manifest) return {};
  const sources = new Map<
    string,
    Promise<{
      source: NonNullable<StepFacts[string]["source"]>;
      readable: boolean;
      published?: boolean;
    }>
  >();
  function sourceOf(kind: NonNullable<StepFacts[string]["source"]>["kind"], name: string) {
    const key = `${kind}:${name}`;
    let pending = sources.get(key);
    if (!pending) {
      pending = (async () => {
        const asset = await options.configAssets.store.getConfigAsset({
          clientInstanceId: options.clientInstanceId,
          kind,
          name
        });
        const resource = asset ? accessResource(kind, name, asset.scope, asset.id) : { kind, name };
        const readable = access.authorize(`${kind}.read`, resource).allowed;
        if (!readable) return { source: { kind }, readable: false };
        if (asset?.status !== "active")
          return { source: { kind }, readable: true, published: false };
        const config = sourceConfigSchema.safeParse(asset.publishedConfig ?? asset.config).data;
        const title = config?.displayName ?? config?.manifest?.name ?? config?.title ?? name;
        return {
          source: { kind, title, ...(config?.service ? { service: config.service } : {}) },
          readable: true,
          published: asset.publishedRevision !== undefined
        };
      })();
      sources.set(key, pending);
    }
    return pending;
  }
  const operations = new Map<string, Promise<OperationFact>>();
  function operationFact(name: string): Promise<OperationFact> {
    let pending = operations.get(name);
    if (!pending) {
      pending = (async (): Promise<OperationFact> => {
        // Use the narrative's parsing of Connection and Data Store names; the remaining
        // registered data operations use the same kind/id/verb naming convention.
        const target = operationTarget(name);
        const parts = name.split(".");
        const kind: NonNullable<StepFacts[string]["source"]>["kind"] =
          target.kind === "connection" || target.kind === "data_store"
            ? target.kind
            : parts[0] === "knowledge"
              ? "knowledge_base"
              : parts[0] === "workflow"
                ? "workflow"
                : "other";
        const sourceName =
          target.kind === "connection"
            ? target.connection
            : target.kind === "data_store"
              ? target.store
              : parts[1];
        const resolved =
          kind !== "other" && sourceName
            ? await sourceOf(kind, sourceName)
            : { source: { kind }, readable: true };
        if (!resolved.readable) return { name, source: resolved.source };
        const operation = await options.operationCalls?.registry.resolve(name);
        if (!operation) return { name, source: resolved.source, available: false };
        const inputSchema = jsonSchemaOf(operation.inputJsonSchema, operation.inputSchema);
        const outputSchema = jsonSchemaOf(operation.outputJsonSchema, operation.outputSchema);
        return {
          name,
          source: resolved.source,
          available: operation.available ?? true,
          effect: operation.effect,
          title: operation.title ?? name.split(".").at(-1)?.replaceAll("_", " ") ?? name,
          ...(operation.description ? { description: operation.description } : {}),
          ...(inputSchema ? { inputSchema } : {}),
          ...(outputSchema ? { outputSchema } : {})
        };
      })();
      operations.set(name, pending);
    }
    return pending;
  }
  const tools = await Promise.all(declared.agentTools.map(operationFact));
  const facts: StepFacts = {};
  for (const step of workflowStepsDeep(manifest.steps)) {
    if (step.type === "operation" && typeof step.operation === "string") {
      const { name: _name, ...fact } = await operationFact(step.operation);
      facts[step.id] = fact;
    } else if (step.type === "workflow" && typeof step.workflow === "string") {
      const child = await sourceOf("workflow", step.workflow);
      facts[step.id] = {
        source: child.source,
        ...(child.readable ? { title: child.source.title, published: child.published } : {})
      };
    } else if (step.type === "trigger") {
      facts[step.id] = { ...schedule, tools };
    } else if (step.type === "agent") {
      const provider = getModelProviderConfigs(options.config)[0];
      const binding = options.config.modelBindings.find(
        (binding) =>
          binding.kind !== "embedding" &&
          binding.providerId === provider?.id &&
          (binding.model ?? provider?.model) === provider?.model
      );
      facts[step.id] = {
        ...(provider ? { model: binding?.label ?? provider.model } : {})
      };
    }
  }
  return facts;
}
