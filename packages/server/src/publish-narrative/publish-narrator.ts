import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  asUserId,
  isGuardrailEvent,
  type AccessResource,
  type ActorAccess,
  type AssetKindRegistry,
  type AssetScope,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type GuardrailEvent,
  type GuardrailFilter,
  type JsonObject,
  type LocaleCode,
  type OperationDefinition,
  type PlatformStores,
  type PublishNarrative,
  type PublishNarrativeAudience,
  type PublishNarrativeStoredData
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import type { GuardrailInForce } from "../guardrails/guardrail-runner";
import {
  appSummary,
  oneLine,
  stopWarnings,
  workflowSummary,
  type NoticeRecipientsSentence,
  type StepStop,
  type WorkflowSentence
} from "./narrative-copy";
import { appFacts, workflowFacts, type AppFacts, type WorkflowFacts } from "./narrative-facts";

// The plain sentence the publish question leads with, and the warning for each step a guardrail
// in force will stop (PUBQ-1). It is computed from the revision's config and what the instance
// knows of the names in it: no step runs, no check of a guardrail runs, no row is read. The
// Publish dialog, the draft bar, the CLI prompt and a held publish's Inbox item show the same.
// Spec: events-workflows-and-guardrails.md, The publish question.

/** What the narrator reads of an asset a revision names. */
type NarratedAsset = Pick<
  ConfigAssetRecord,
  "id" | "kind" | "name" | "scope" | "status" | "config" | "publishedConfig"
>;

export interface PublishNarratorOptions {
  clientInstanceId: ClientInstanceId;
  stores: {
    configAssets: {
      getConfigAsset(
        ...input: Parameters<ConfigAssetStore["getConfigAsset"]>
      ): Promise<NarratedAsset | undefined>;
    };
    workspaces: {
      getWorkspace(
        ...input: Parameters<PlatformStores["workspaces"]["getWorkspace"]>
      ): Promise<{ name: string } | undefined>;
    };
    /** The people a `notify` step names, for their names. */
    users: {
      getUser(
        ...input: Parameters<PlatformStores["users"]["getUser"]>
      ): Promise<{ displayLabel: string } | undefined>;
    };
  };
  /** The registered kinds, for the account a Workflow runs as. */
  kinds?: Pick<AssetKindRegistry<WorkflowAssetKind>, "get">;
  /** The guardrails in force. Without them no warning is given. */
  guardrails?: {
    inForce(event: GuardrailEvent, match: GuardrailFilter): Promise<GuardrailInForce[]>;
  };
  /** The definition of an operation a step calls, where this process registers it. */
  resolve(operation: string): Promise<Pick<OperationDefinition, "effect" | "events"> | undefined>;
  /** Who sees which stored data (DS-13b). Absent where the stored-data module is off. */
  storedData?: PublishNarrativeStoredData;
}

export interface PublishNarrateInput {
  kind: string;
  name: string;
  scope: AssetScope;
  /** The stored revision `config` is of. */
  revision: number;
  config: JsonObject | null;
  locale: LocaleCode;
  /** The reader: what is named of the instance's assets is what they may be shown. */
  access: ActorAccess;
}

export interface PublishNarrator {
  /** Nothing for a kind without a publish question, or a config that holds no manifest. */
  narrate(input: PublishNarrateInput): Promise<PublishNarrative | undefined>;
}

export function createPublishNarrator(options: PublishNarratorOptions): PublishNarrator {
  return {
    async narrate(input) {
      if (input.kind === WORKFLOW_ASSET_KIND) {
        const facts = workflowFacts(input.config, input.name);
        return facts && narrateWorkflow(options, input, facts);
      }
      if (input.kind === APP_ASSET_KIND) {
        const facts = appFacts(input.config, input.name);
        return facts && narrateApp(options, input, facts);
      }
      return undefined;
    }
  };
}

const displayNameSchema = z.object({ displayName: z.string().min(1) });
const titleSchema = z.object({ title: z.string().min(1) });
/** A Workflow's name people read is its manifest's `name`, as its kind summarizes it. */
const workflowTitleSchema = z.object({ manifest: z.object({ name: z.string().min(1) }) });

/**
 * The names people read of the assets of one kind, by name, each read once: the title of each
 * one the reader may be shown by one of `rights`; its name, which the revision itself names,
 * for any other.
 */
function assetTitles(
  options: PublishNarratorOptions,
  access: ActorAccess,
  kind: string,
  rights: readonly string[],
  title: (config: unknown) => string | undefined
) {
  const read = new Map<string, Promise<string>>();
  return (name: string): Promise<string> => {
    let found = read.get(name);
    if (!found) {
      found = options.stores.configAssets
        .getConfigAsset({ clientInstanceId: options.clientInstanceId, kind, name })
        .then((asset) => {
          if (asset?.status !== "active") return name;
          const resource: AccessResource = {
            kind: asset.kind,
            name: asset.name,
            assetId: asset.id,
            ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
          };
          const shown = rights.some((right) => access.authorize(right, resource).allowed);
          return oneLine(
            (shown ? title(asset.publishedConfig ?? asset.config) : undefined) ?? name
          );
        });
      read.set(name, found);
    }
    return found;
  };
}

function namers(options: PublishNarratorOptions, access: ActorAccess) {
  return {
    connection: assetTitles(
      options,
      access,
      CONNECTION_ASSET_KIND,
      [CONNECTION_ACTIONS.read, CONNECTION_ACTIONS.use],
      (config) => displayNameSchema.safeParse(config).data?.displayName
    ),
    store: assetTitles(
      options,
      access,
      DATA_STORE_ASSET_KIND,
      [DATA_STORE_ACTIONS.read, DATA_STORE_ACTIONS.write],
      (config) => titleSchema.safeParse(config).data?.title
    ),
    workflow: assetTitles(
      options,
      access,
      WORKFLOW_ASSET_KIND,
      [WORKFLOW_ACTIONS.read, WORKFLOW_ACTIONS.use],
      (config) => workflowTitleSchema.safeParse(config).data?.manifest.name
    ),
    workspace: async (id: string) =>
      (
        await options.stores.workspaces.getWorkspace(
          options.clientInstanceId,
          asCollaborationWorkspaceId(id)
        )
      )?.name,
    person: async (id: string) =>
      (
        await options.stores.users.getUser({
          clientInstanceId: options.clientInstanceId,
          userId: asUserId(id)
        })
      )?.displayLabel
  };
}

/** Every name the stored-data module answers, on one line: a line break would forge a line. */
function audienceOnOneLine(audience: PublishNarrativeAudience): PublishNarrativeAudience {
  return audience.workspace
    ? {
        ...audience,
        workspace: { ...audience.workspace, title: oneLine(audience.workspace.title) }
      }
    : audience;
}

/**
 * Who the `notify` steps reach, by the channels they use: the steps of one set of channels
 * together, each person and workspace once. A person or workspace the instance does not know is
 * counted, never named by its id.
 */
async function noticeRecipients(
  names: ReturnType<typeof namers>,
  steps: WorkflowFacts["notifySteps"]
): Promise<NoticeRecipientsSentence[]> {
  const byChannels = new Map<
    string,
    {
      channels: WorkflowFacts["notifySteps"][number]["channels"];
      users: string[];
      workspaces: string[];
    }
  >();
  for (const step of steps) {
    const key = step.channels.join("+");
    const entry = byChannels.get(key) ?? { channels: step.channels, users: [], workspaces: [] };
    entry.users.push(...step.users);
    entry.workspaces.push(...step.workspaces);
    byChannels.set(key, entry);
  }
  return Promise.all(
    [...byChannels.values()].map(async (entry) => {
      const people = await Promise.all(once(entry.users).map(names.person));
      const workspaces = await Promise.all(once(entry.workspaces).map(names.workspace));
      const named = (values: readonly (string | undefined)[]) =>
        values.flatMap((value) => (value === undefined ? [] : [oneLine(value)]));
      return {
        channels: entry.channels,
        people: named(people),
        unnamedPeople: people.filter((value) => value === undefined).length,
        workspaces: named(workspaces),
        unnamedWorkspaces: workspaces.filter((value) => value === undefined).length
      };
    })
  );
}

/** Each name once, in the order first named. */
const once = (names: readonly string[]) => [...new Set(names)];

async function narrateWorkflow(
  options: PublishNarratorOptions,
  input: PublishNarrateInput,
  facts: WorkflowFacts
): Promise<PublishNarrative> {
  const names = namers(options, input.access);
  const definitions = new Map(
    await Promise.all(
      once(facts.operationSteps.map((step) => step.operation)).map(
        async (operation) => [operation, await options.resolve(operation)] as const
      )
    )
  );
  const reads: string[] = [];
  const adds: string[] = [];
  const changes: string[] = [];
  const proposes: string[] = [];
  const writtenStores: string[] = [];
  const uses: { through?: string; step: string }[] = [];
  for (const step of facts.operationSteps) {
    const { target } = step;
    const effect = definitions.get(step.operation)?.effect;
    if (target.kind === "data_store") {
      const title = await names.store(target.store);
      if (target.effect === "reads") reads.push(title);
      else {
        (target.effect === "adds" ? adds : target.effect === "changes" ? changes : proposes).push(
          title
        );
        writtenStores.push(target.store);
      }
    } else if (target.kind === "connection") {
      const title = await names.connection(target.connection);
      // An operation this process does not know is said as used, not as read: it may change.
      if (effect === "reading") reads.push(title);
      else uses.push({ through: title, step: oneLine(step.name) });
    } else if (effect === "reading") {
      reads.push(`“${oneLine(step.name)}”`);
    } else {
      uses.push({ step: oneLine(step.name) });
    }
  }
  const kind = options.kinds?.get(WORKFLOW_ASSET_KIND);
  const account =
    input.config && kind?.readRunsAs ? await kind.readRunsAs(input.config) : facts.runAs;
  const sentence: WorkflowSentence = {
    title: oneLine(facts.title),
    triggers: facts.triggers,
    ...(account === undefined ? {} : { account: oneLine(account) }),
    reads: once(reads),
    // A store that a step may change is said once, as changed, and not also as added to.
    adds: once(adds).filter((title) => !changes.includes(title)),
    changes: once(changes),
    proposes: once(proposes),
    uses,
    notifies: await noticeRecipients(names, facts.notifySteps),
    children: await Promise.all(facts.children.map(names.workflow)),
    agentSteps: facts.agentSteps,
    agentTools: facts.agentTools.length,
    ...(options.storedData && writtenStores.length > 0
      ? {
          readers: (await options.storedData.storeReaders(input.access, once(writtenStores))).map(
            (store) => ({
              ...store,
              title: oneLine(store.title),
              readers: store.readers.map((reader) => ({
                ...reader,
                title: oneLine(reader.title),
                audience: audienceOnOneLine(reader.audience)
              }))
            })
          )
        }
      : {})
  };
  return {
    summary: workflowSummary(sentence, input.locale),
    warnings: stopWarnings(await stepStops(options, input.scope, facts, definitions), input.locale)
  };
}

/**
 * The steps a guardrail in force will stop when the published revision runs: a published run
 * cannot wait for an approval, so a `require_approval` stops its step as a `block` does
 * (WF-AUTO-1). A step meets the guardrails of `operation.before_call` and of its operation's
 * own before-event, with the run's origin and the Workflow's workspace. A guardrail that checks
 * content is said as "may": whether it matches is known only when the step runs.
 */
async function stepStops(
  options: PublishNarratorOptions,
  scope: AssetScope,
  facts: WorkflowFacts,
  definitions: ReadonlyMap<string, Pick<OperationDefinition, "events"> | undefined>
): Promise<StepStop[]> {
  const { guardrails } = options;
  if (!guardrails) return [];
  const where: GuardrailFilter = {
    origin: "workflow",
    ...(scope.kind === "workspace" ? { workspace: scope.workspaceId } : {})
  };
  const asked = new Map<string, Promise<GuardrailInForce[]>>();
  const inForce = (event: GuardrailEvent, match: GuardrailFilter) => {
    const key = `${event}\u0000${match.operation ?? ""}`;
    let found = asked.get(key);
    if (!found) {
      found = guardrails.inForce(event, match);
      asked.set(key, found);
    }
    return found;
  };
  const stops: StepStop[] = [];
  for (const step of facts.operationSteps) {
    const own = definitions.get(step.operation)?.events?.before;
    const met = [
      ...(await inForce("operation.before_call", { ...where, operation: step.operation })),
      ...(own !== undefined && isGuardrailEvent(own) ? await inForce(own, where) : [])
    ];
    for (const guardrail of met) {
      if (guardrail.outcome !== "require_approval" && guardrail.outcome !== "block") continue;
      stops.push({
        step: oneLine(step.name),
        guardrail: oneLine(guardrail.displayName),
        outcome: guardrail.outcome,
        checked: guardrail.checked
      });
    }
  }
  return stops;
}

async function narrateApp(
  options: PublishNarratorOptions,
  input: PublishNarrateInput,
  facts: AppFacts
): Promise<PublishNarrative> {
  const names = namers(options, input.access);
  // Who may use it and what its reading statements show them, as DS-13b reads it for this
  // revision. A reader the stored-data module refuses gets the plain line without counts.
  const stored = await options.storedData
    ?.appRevision(input.access, input.name, input.revision)
    .catch(() => undefined);
  const workspace =
    input.scope.kind === "workspace" ? await names.workspace(input.scope.workspaceId) : undefined;
  const stores =
    stored?.stores ??
    (await Promise.all(
      facts.readsStores.map(async (store) => ({
        title: await names.store(store),
        unavailable: false,
        fillers: []
      }))
    ));
  return {
    summary: appSummary(
      {
        title: oneLine(facts.title),
        ...(stored?.audience ? { audience: audienceOnOneLine(stored.audience) } : {}),
        ...(stored?.truncated ? { truncated: true } : {}),
        ...(workspace === undefined ? {} : { workspace: oneLine(workspace) }),
        stores: stores.map((store) => ({
          ...store,
          title: oneLine(store.title),
          fillers: store.fillers.map((filler) => ({
            title: oneLine(filler.title),
            connections: filler.connections.map(oneLine)
          }))
        })),
        readsConnections: await Promise.all(facts.readsConnections.map(names.connection)),
        changes: await Promise.all(
          facts.changes.map(async (change) =>
            change.kind === "insert"
              ? { kind: change.kind, store: await names.store(change.store) }
              : change.kind === "workflow"
                ? { kind: change.kind, workflow: await names.workflow(change.workflow) }
                : {
                    kind: change.kind,
                    connection: await names.connection(change.connection),
                    action: oneLine(change.action)
                  }
          )
        )
      },
      input.locale
    ),
    // An App's actions run as their viewer, who is present and may be asked: a guardrail holds
    // its call and does not stop it, so nothing here warns.
    warnings: []
  };
}
