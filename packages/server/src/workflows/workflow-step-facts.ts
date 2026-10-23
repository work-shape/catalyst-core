import type { Asset } from "@work-shape/catalyst-api-contract";
import {
  MAIL_SEND_OPERATION,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_SYSTEM_ICON,
  workflowStepsDeep,
  type ActorAccess,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { jsonSchemaOf } from "../platform/platform-callable-operations";
import { workflowFacts } from "../publish-narrative/narrative-facts";
import { operationTitle, readOperationSource, sourceReader } from "../platform/operation-sources";
import type { AssetWorkflowOptions } from "../types";

type StepFacts = NonNullable<Asset["stepFacts"]>;
type OperationFact = NonNullable<StepFacts[string]["tools"]>[number];
const manifestSchema = z.object({ manifest: z.object({ steps: z.unknown() }) });

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
  const sourceOf = sourceReader(options, access);
  const mail = options.config.infrastructure.mail;
  const mailSender = mail?.outbound.enabled
    ? {
        sender: MAIL_SENDER_SYSTEM,
        title: mail.sender.fromName ?? options.config.clientInstance.displayName,
        icon: MAIL_SENDER_SYSTEM_ICON,
        address: mail.sender.fromAddress,
        recipientDomains: mail.outbound.recipientDomains
      }
    : undefined;
  const operations = new Map<string, Promise<OperationFact>>();
  function operationFact(name: string): Promise<OperationFact> {
    let pending = operations.get(name);
    if (!pending) {
      pending = (async (): Promise<OperationFact> => {
        const resolved =
          name === MAIL_SEND_OPERATION
            ? {
                readable: true,
                source: {
                  kind: "mail_sender" as const,
                  ...(mailSender ? { title: mailSender.title, service: mailSender.icon } : {})
                }
              }
            : await readOperationSource(sourceOf, name);
        if (!resolved.readable) return { name, source: resolved.source };
        const operation = await options.operationCalls?.registry.resolve(name);
        if (!operation) return { name, source: resolved.source, available: false };
        const inputSchema = jsonSchemaOf(operation.inputJsonSchema, operation.inputSchema);
        const outputSchema = jsonSchemaOf(operation.outputJsonSchema, operation.outputSchema);
        return {
          name,
          source: resolved.source,
          ...(name === MAIL_SEND_OPERATION && mailSender ? { mailSender } : {}),
          available: operation.available ?? true,
          effect: operation.effect,
          title: operationTitle(operation),
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
      // Only what the step declares: the binding it runs on is CR-2's to tell, not guessed here.
      facts[step.id] = typeof step.model === "string" ? { model: step.model } : {};
    }
  }
  return facts;
}
