import { z } from "zod";
import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  isJsonObject,
  unknownToJsonValue,
  INSTANCE_ASSET_SCOPE,
  type AccessDecision,
  type ActorAccess,
  type AssetScope,
  type ConfigAssetRecord,
  type GuardrailConfig,
  type JsonObject,
  type LocaleCode,
  type OperationEffect,
  type OperationDefinition,
  type PublishNarrativeStoredData
} from "@work-shape/catalyst-core";
import type { ReleaseGuardrailConfig } from "@work-shape/catalyst-config-schema";
import { GuardrailRunner, createPublishNarrator } from "@work-shape/catalyst-server";
import { createTestConfig } from "./fixtures";

// Read-only publish review fixtures: no model, operation, row write or guardrail hit.

export const clientInstanceId = asClientInstanceId("ci_pubq");
export const WORKSPACE = asCollaborationWorkspaceId("cw_kai");
export const workspaceScope: AssetScope = { kind: "workspace", workspaceId: WORKSPACE };

function jsonObject(value: unknown): JsonObject {
  const converted = unknownToJsonValue(value);
  if (!isJsonObject(converted)) throw new Error("Expected a JSON object");
  return converted;
}

function record(
  kind: string,
  name: string,
  config: JsonObject,
  scope: AssetScope = workspaceScope
): ConfigAssetRecord {
  return {
    id: `asset_${kind}_${name}`,
    clientInstanceId,
    kind,
    name,
    scope,
    status: "active",
    activeRevisionId: `rev_${name}`,
    revision: 1,
    config,
    publishedRevisionId: `rev_${name}`,
    publishedRevision: 1,
    publishedConfig: config,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z"
  };
}

const ASSETS = [
  record("connection", "exampledata", { displayName: "Exampledata" }),
  record("connection", "outlook", { displayName: "Outlook" }),
  record("data_store", "findings", { title: "Findings" }),
  record("data_store", "ledger", { title: "Ledger" }),
  record("data_store", "facts", { title: "Facts" }),
  // A Workflow's visible name is its manifest's `name`, never its id.
  record("workflow", "child_fetch", { manifest: { id: "child_fetch", name: "Belege holen" } })
];

const PEOPLE: Record<string, string> = { usr_anna: "Anna Berg", usr_ben: "Ben Kurz" };

const allowed: AccessDecision = { allowed: true, source: "grant" };
export const everything: ActorAccess = {
  authorize: () => allowed,
  require: () => undefined,
  holdsGrantAt: () => true,
  denials: () => []
};
export const nothing: ActorAccess = {
  ...everything,
  authorize: () => ({ allowed: false, reason: "no_grant" })
};

const EFFECTS: Record<string, OperationEffect> = {
  "connection.exampledata.list_clients": "reading",
  "connection.exampledata.list_postings": "reading",
  "connection.outlook.send_mail": "changing"
};

export function operationDefinition(
  name: string,
  effect: OperationEffect = "changing"
): OperationDefinition {
  return {
    name,
    effect,
    scope: null,
    auth: "principal",
    action: "workflow.use",
    timeoutMs: 1000,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    resource: () =>
      name.startsWith("data_store.")
        ? { kind: "data_store", id: "findings", workspaceId: WORKSPACE }
        : { kind: "operation", id: name },
    execute: () => {
      throw new Error("Publish preview must never execute");
    }
  };
}

/** The Exampledata Workflow of check 75: it reads Exampledata, inserts into Findings, mails a Mandant. */
export function nightlyImport(): JsonObject {
  return {
    name: "nachtimport",
    title: "Nachtimport",
    manifest: {
      id: "nachtimport",
      name: "Nachtimport",
      runAs: "nachtimport-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        {
          id: "start",
          name: "Start",
          type: "trigger",
          triggers: [{ kind: "schedule", cron: "0 2 * * *" }]
        },
        {
          id: "clients",
          name: "Mandanten lesen",
          type: "operation",
          operation: "connection.exampledata.list_clients",
          input: {}
        },
        {
          id: "postings",
          name: "Buchungen lesen",
          type: "operation",
          operation: "connection.exampledata.list_postings",
          input: {}
        },
        {
          id: "store",
          name: "Befunde speichern",
          type: "operation",
          operation: "data_store.findings.insert",
          input: {}
        },
        {
          id: "mail",
          name: "Mail an Mandanten",
          type: "operation",
          operation: "connection.outlook.send_mail",
          input: { to: { ref: { step: "clients", path: "email" } } }
        }
      ]
    }
  };
}

export const APP: "app" = "app";

/** The App Findings on the store, used by the 14 people of Kai Spezis. */
export const storedData: PublishNarrativeStoredData = {
  appRevision: () =>
    Promise.resolve({
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: 0 },
      stores: [
        {
          title: "Findings",
          unavailable: false,
          fillers: [{ title: "Nachtimport", connections: ["Exampledata"] }]
        }
      ],
      truncated: false
    }),
  storeReaders: (_access, stores) =>
    Promise.resolve(
      stores.map((store) => ({
        store,
        title: "Findings",
        readers: [
          {
            kind: APP,
            title: "Findings",
            audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: 0 }
          }
        ],
        hidden: 0,
        truncated: false
      }))
    )
};

export const ibanApproval: GuardrailConfig = {
  name: "mail-iban-approval",
  displayName: "E-Mail senden: IBAN → Freigabe",
  on: "operation.before_call",
  filter: { operation: "connection.outlook.send_mail" },
  check: { kind: "pattern", pattern: "(?i)DE\\d{20}", reason: "Eine IBAN braucht eine Freigabe." },
  outcome: "require_approval",
  origin: "asset"
};

export function narrator(input: {
  guardrails?: readonly { guardrail: GuardrailConfig; scope?: AssetScope }[];
  floor?: Record<string, ReleaseGuardrailConfig>;
  shippedOff?: boolean;
  stored?: PublishNarrativeStoredData;
  definitions?: readonly OperationDefinition[];
  policy?: RunOperationDeps["policy"];
  onModel?: () => void;
  onHit?: () => void;
}) {
  const base = createTestConfig();
  const runner = new GuardrailRunner({
    clientInstanceId,
    config: { ...base, guardrails: { ...base.guardrails, ...input.floor } },
    modelGateway: {
      complete: () => {
        input.onModel?.();
        return Promise.reject(new Error("The publish question calls no model"));
      },
      capabilities: () => {
        throw new Error("The publish question calls no model");
      }
    },
    hits: {
      recordHits: () => {
        input.onHit?.();
        return Promise.reject(new Error("The publish question keeps no hit"));
      }
    },
    assets: {
      listPublishedConfigAssets: () =>
        Promise.resolve(
          (input.guardrails ?? []).map(({ guardrail, scope }) =>
            record(
              "guardrail",
              guardrail.name,
              jsonObject(guardrail),
              scope ?? INSTANCE_ASSET_SCOPE
            )
          )
        )
    },
    shipped: {
      listShippedGuardrailSwitches: () =>
        Promise.resolve(
          input.shippedOff
            ? [
                {
                  name: "publishing-needs-approval",
                  enabled: false,
                  switchedBy: { id: "usr_admin", label: "Admin" },
                  switchedAt: "2026-10-18T00:00:00.000Z"
                }
              ]
            : []
        )
    }
  });
  return createPublishNarrator({
    clientInstanceId,
    stores: {
      configAssets: {
        getConfigAsset: ({ kind, name }) =>
          Promise.resolve(ASSETS.find((asset) => asset.kind === kind && asset.name === name))
      },
      workspaces: {
        getWorkspace: (_instance, id) =>
          Promise.resolve(id === WORKSPACE ? { name: "Kai Spezis" } : undefined)
      },
      users: {
        getUser: ({ userId }) => {
          const displayLabel = PEOPLE[userId];
          return Promise.resolve(displayLabel === undefined ? undefined : { displayLabel });
        }
      }
    },
    guardrails: runner,
    resolve: (operation) => {
      const override = input.definitions?.find((definition) => definition.name === operation);
      if (override) return Promise.resolve(override);
      const effect =
        EFFECTS[operation] ??
        (operation.startsWith("data_store.") || operation.startsWith("workflow.")
          ? "changing"
          : undefined);
      return Promise.resolve(effect ? operationDefinition(operation, effect) : undefined);
    },
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.stored === undefined ? { storedData } : { storedData: input.stored })
  });
}

export async function narrateWorkflow(
  locale: LocaleCode,
  options: Parameters<typeof narrator>[0] = { guardrails: [{ guardrail: ibanApproval }] },
  config: JsonObject = nightlyImport()
) {
  const narrative = await narrator(options).narrate({
    kind: "workflow",
    name: "nachtimport",
    scope: workspaceScope,
    revision: 3,
    config,
    locale,
    access: everything
  });
  if (!narrative) throw new Error("A Workflow revision is narrated");
  return narrative;
}
