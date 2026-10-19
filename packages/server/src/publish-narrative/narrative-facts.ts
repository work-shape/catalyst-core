import { compiledActionsOf } from "@work-shape/catalyst-app-build";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_VERBS,
  NOTIFY_CHANNELS,
  parseConnectionOperationName,
  workflowStartOperationName,
  WORKFLOW_START_KEY_INPUT,
  workflowStepsDeep
} from "@work-shape/catalyst-core";
import { z } from "zod";

// What a revision declares that the publish question's sentence names, read from its config
// alone: no step runs and no row is read. An App's actions and a Workflow's steps, triggers and
// account. The narrator adds what the instance knows of them: names, effects, readers.

export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * What a store's verb does to its rows: `insert` only adds, `load` may also change or remove
 * them (`onConflict: "update"`, `replace`), `records.propose` proposes values for records. A
 * verb this release does not know may change rows.
 */
type StoreVerbEffect = "reads" | "adds" | "changes" | "proposes";

/** What one operation a step calls is, by its name alone. */
type OperationTarget =
  | { kind: "data_store"; store: string; effect: StoreVerbEffect }
  | { kind: "connection"; connection: string }
  | { kind: "other" };

export type WorkflowTriggerFact =
  /** `timeZone`: the zone the trigger names; the narrator fills in the instance's. */
  | { kind: "schedule"; cron: string; timeZone?: string }
  | { kind: "manual" }
  | { kind: "parent" }
  /** A trigger kind this release does not word. */
  | { kind: "other"; name: string };

export interface WorkflowFacts {
  kind: "workflow";
  title: string;
  triggers: readonly WorkflowTriggerFact[];
  /** The service principal a run acts as, as the definition names it. */
  runAs?: string;
  /** Every operation step at any depth, in the definition's order. */
  operationSteps: readonly {
    id: string;
    name: string;
    operation: string;
    target: OperationTarget;
  }[];
  /** Calls made through runtime operation admission, including child Workflow starts. */
  calls: readonly {
    id: string;
    name: string;
    operation: string;
    input: unknown;
    dynamic: boolean;
  }[];
  notifySteps: readonly {
    name: string;
    channels: readonly NotifyChannel[];
    users: readonly string[];
    workspaces: readonly string[];
  }[];
  /** The child Workflows its `workflow` steps start, each once. */
  children: readonly string[];
  /** How many agent steps it has, and the operations they may call as tools. */
  agentSteps: number;
  agentTools: readonly string[];
}

export interface AppFacts {
  kind: "app";
  title: string;
  /** The Connections its reading actions call, each once. */
  readsConnections: readonly string[];
  /** The stores its reading `sql` actions read, each once. */
  readsStores: readonly string[];
  /** What its changing actions do, in manifest order. */
  changes: readonly (
    | { kind: "insert"; store: string }
    | { kind: "connection"; connection: string; action: string }
    | { kind: "workflow"; workflow: string }
  )[];
}

function verbEffect(verb: string): StoreVerbEffect {
  const known = DATA_STORE_OPERATION_VERBS.find((candidate) => candidate === verb);
  if (known === undefined) return "changes";
  if (DATA_STORE_OPERATION_RIGHTS[known] === DATA_STORE_ACTIONS.read) return "reads";
  if (known === "insert") return "adds";
  if (known === "records.propose") return "proposes";
  return "changes";
}

/** What an operation's name says it reaches. */
export function operationTarget(operation: string): OperationTarget {
  if (operation.startsWith(DATA_STORE_OPERATION_PREFIX)) {
    const rest = operation.slice(DATA_STORE_OPERATION_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot > 0) {
      return {
        kind: "data_store",
        store: rest.slice(0, dot),
        effect: verbEffect(rest.slice(dot + 1))
      };
    }
  }
  const connection = parseConnectionOperationName(operation)?.connection;
  return connection ? { kind: "connection", connection } : { kind: "other" };
}

const workflowConfigSchema = z.object({
  title: z.string().optional(),
  manifest: z.object({
    name: z.string().optional(),
    runAs: z.string().optional(),
    steps: z.unknown(),
    tools: z.array(z.string()).optional()
  })
});

const channelsSchema = z.array(z.string());

const triggerSchema = z.object({
  kind: z.string(),
  cron: z.string().optional(),
  timeZone: z.string().optional()
});

/** The facts of a Workflow revision, or nothing where its config holds no manifest. */
export function workflowFacts(config: unknown, name: string): WorkflowFacts | undefined {
  const parsed = workflowConfigSchema.safeParse(config);
  if (!parsed.success) return undefined;
  const { manifest } = parsed.data;
  const steps = workflowStepsDeep(manifest.steps);
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.length > 0 ? value : fallback;
  const [first] = steps;
  const triggers: WorkflowTriggerFact[] =
    first?.type === "trigger" && Array.isArray(first.triggers)
      ? first.triggers.flatMap((entry): WorkflowTriggerFact[] => {
          const trigger = triggerSchema.safeParse(entry);
          if (!trigger.success) return [];
          const { kind, cron, timeZone } = trigger.data;
          if (kind === "schedule" && cron !== undefined) {
            return [{ kind, cron, ...(timeZone === undefined ? {} : { timeZone }) }];
          }
          if (kind === "manual" || kind === "parent") return [{ kind }];
          return [{ kind: "other", name: kind }];
        })
      : [];
  const recipients = z.object({
    users: z.array(z.string()).optional(),
    workspaces: z.array(z.string()).optional()
  });
  return {
    kind: "workflow",
    title: text(manifest.name, parsed.data.title ?? name),
    triggers,
    ...(manifest.runAs === undefined ? {} : { runAs: manifest.runAs }),
    operationSteps: steps.flatMap((step) =>
      step.type === "operation" && typeof step.operation === "string"
        ? [
            {
              id: step.id,
              name: text(step.name, step.id),
              operation: step.operation,
              target: operationTarget(step.operation)
            }
          ]
        : []
    ),
    calls: steps.flatMap((step) => {
      const operation =
        step.type === "operation" && typeof step.operation === "string"
          ? step.operation
          : step.type === "workflow" && typeof step.workflow === "string"
            ? workflowStartOperationName(step.workflow)
            : undefined;
      if (!operation) return [];
      const mapping = z
        .record(
          z.string(),
          z.object({ value: z.unknown().optional(), ref: z.unknown().optional() })
        )
        .safeParse(step.input ?? {});
      const input = Object.fromEntries(
        Object.entries(mapping.data ?? {}).map(([key, source]) => [key, source.value])
      );
      let dynamic =
        !mapping.success ||
        Object.values(mapping.data ?? {}).some((source) => source.ref !== undefined);
      if (step.type === "workflow" && step.key !== undefined) {
        // A key's references are resolved only during the run, like the child's other input.
        dynamic = true;
        input[WORKFLOW_START_KEY_INPUT] = undefined;
      }
      return [{ id: step.id, name: text(step.name, step.id), operation, input, dynamic }];
    }),
    notifySteps: steps.flatMap((step) => {
      if (step.type !== "notify") return [];
      const to = recipients.safeParse(step.to).data;
      const named = channelsSchema.safeParse(step.channels).data ?? [];
      const channels = NOTIFY_CHANNELS.filter((channel) => named.includes(channel));
      return [
        {
          name: text(step.name, step.id),
          channels,
          users: [...new Set(to?.users ?? [])],
          workspaces: [...new Set(to?.workspaces ?? [])]
        }
      ];
    }),
    children: [
      ...new Set(
        steps.flatMap((step) =>
          step.type === "workflow" && typeof step.workflow === "string" ? [step.workflow] : []
        )
      )
    ],
    agentSteps: steps.filter((step) => step.type === "agent").length,
    agentTools: [...new Set(manifest.tools ?? [])]
  };
}

const appConfigSchema = z.object({
  title: z.string().optional(),
  manifest: z.unknown()
});

/** The facts of an App revision, or nothing where its config holds no manifest. */
export function appFacts(config: unknown, name: string): AppFacts | undefined {
  const parsed = appConfigSchema.safeParse(config);
  if (!parsed.success) return undefined;
  const actions = compiledActionsOf(parsed.data.manifest);
  const once = (values: readonly string[]) => [...new Set(values)];
  return {
    kind: "app",
    title: parsed.data.title ?? name,
    readsConnections: once(
      actions.flatMap((action) =>
        action.kind === "connection" && action.effect === "reading" ? [action.connection] : []
      )
    ),
    readsStores: once(
      actions.flatMap((action) =>
        action.kind === "sql" && action.effect === "reading" ? [action.dataStore] : []
      )
    ),
    changes: actions.flatMap((action): AppFacts["changes"] => {
      if (action.effect !== "changing") return [];
      if (action.kind === "sql") return [{ kind: "insert", store: action.dataStore }];
      if (action.kind === "workflow") return [{ kind: "workflow", workflow: action.workflow }];
      return [{ kind: "connection", connection: action.connection, action: action.name }];
    })
  };
}
