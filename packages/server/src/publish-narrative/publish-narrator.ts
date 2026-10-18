import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  CONNECTION_ACTIONS,
  isGuardrailEvent,
  PLATFORM_EVENT_ALLOW,
  strictestOutcome,
  CONNECTION_ASSET_KIND,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  asUserId,
  type AccessResource,
  type ActorAccess,
  type AssetKindRegistry,
  type AssetScope,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type JsonObject,
  type LocaleCode,
  type OperationDefinition,
  type PlatformStores,
  type PublishNarrative,
  type PublishNarrativeAudience,
  type PublishNarrativeStoredData
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  operationWorkspace,
  resolveGuardedPolicy,
  type RunOperationDeps
} from "@work-shape/catalyst-tool-execution";
import { guardrailMatch } from "../operations/event-emitter";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import type { GuardrailRunner } from "../guardrails/guardrail-runner";
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
import { workspaceDisplayName, type NamedWorkspace } from "./workspace-name";

// Keeps outside input checks from holding the publish question; unchecked steps say they may stop.
const NARRATION_BUDGET_MS = 3_000;
// Leaves time inside the same budget to assemble warnings for unfinished checks.
const NARRATION_FINISH_MARGIN_MS = 50;
// Bounds concurrent schema and policy work without serializing a large Workflow's review.
const NARRATION_CHECK_CONCURRENCY = 4;

// The plain sentence the publish question leads with, and the warning for each step a guardrail
// in force will stop (PUBQ-1). It is computed from the revision's config and what the instance
// knows of the names in it: no step runs, no model is called, no hit is kept and no row is read. The
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
      ): Promise<NamedWorkspace | undefined>;
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
  /** Runtime guardrails, dry-evaluated without model calls or recorded hits. */
  guardrails?: Pick<GuardrailRunner, "previewSession">;
  /** The definition of an operation a step calls, where this process registers it. */
  resolve(operation: string): Promise<OperationDefinition | undefined>;
  /** The same central settings and defaults used by operation admission. */
  policy?: RunOperationDeps["policy"];
  /** Who sees which stored data (DS-13b). Absent where the stored-data module is off. */
  storedData?: PublishNarrativeStoredData;
}

export interface PublishNarrateInput {
  audienceLabel?: string;
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

/** A failed optional summary must leave the revision's Details and publish action available. */
export function unavailablePublishNarrative(locale: LocaleCode): PublishNarrative {
  return {
    summary:
      locale === "de"
        ? "Die Zusammenfassung konnte nicht erstellt werden. Die Details sind weiterhin verfügbar."
        : "The summary could not be prepared. Details are still available.",
    warnings: []
  };
}

export function createPublishNarrator(options: PublishNarratorOptions): PublishNarrator {
  return {
    async narrate(input) {
      if (input.kind === WORKFLOW_ASSET_KIND) {
        const facts = workflowFacts(input.config, input.name);
        return facts && withinNarrationBudget(narrateWorkflow(options, input, facts));
      }
      if (input.kind === APP_ASSET_KIND) {
        const facts = appFacts(input.config, input.name);
        return facts && withinNarrationBudget(narrateApp(options, input, facts));
      }
      return undefined;
    }
  };
}

async function withinNarrationBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Publish narration timed out")),
          NARRATION_BUDGET_MS
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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

function namers(options: PublishNarratorOptions, access: ActorAccess, locale: LocaleCode) {
  const person = async (id: string) =>
    (
      await options.stores.users.getUser({
        clientInstanceId: options.clientInstanceId,
        userId: asUserId(id)
      })
    )?.displayLabel;
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
    // A workspace by the name the interface shows: a Personal Workspace after its owner.
    workspace: async (id: string) => {
      const workspace = await options.stores.workspaces.getWorkspace(
        options.clientInstanceId,
        asCollaborationWorkspaceId(id)
      );
      return workspace && workspaceDisplayName(workspace, locale, person);
    },
    person
  };
}

/** Every audience name stays on one line. An App supplies its already resolved owner name. */
function audienceOnOneLine(
  audience: PublishNarrativeAudience,
  workspaceName?: string
): PublishNarrativeAudience {
  return audience.workspace
    ? {
        ...audience,
        workspace: {
          ...audience.workspace,
          title: oneLine(workspaceName ?? audience.workspace.title)
        }
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
  const deadline = Date.now() + NARRATION_BUDGET_MS - NARRATION_FINISH_MARGIN_MS;
  const definitions = new Map(
    await Promise.all(
      once(facts.calls.map((step) => step.operation)).map(
        async (operation) => [operation, await options.resolve(operation)] as const
      )
    )
  );
  const [sentence, stops] = await Promise.all([
    workflowSentence(options, input, facts, definitions),
    stepStops(options, facts, definitions, deadline)
  ]);
  return {
    summary: workflowSummary(sentence, input.locale),
    warnings: stopWarnings(stops, input.locale)
  };
}

async function workflowSentence(
  options: PublishNarratorOptions,
  input: PublishNarrateInput,
  facts: WorkflowFacts,
  definitions: ReadonlyMap<string, OperationDefinition | undefined>
): Promise<WorkflowSentence> {
  const names = namers(options, input.access, input.locale);
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
  return {
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
}

/**
 * Dry admission of every declared call. Runtime and preview share effective workspace,
 * policy resolution, before-event enumeration and guardrail binding. Content checks remain
 * conditional: no judge, hit, approval, operation run or step is executed by a preview.
 */
async function stepStops(
  options: PublishNarratorOptions,
  facts: WorkflowFacts,
  definitions: ReadonlyMap<string, OperationDefinition | undefined>,
  deadline: number
): Promise<StepStop[]> {
  const guardrails = options.guardrails?.previewSession();
  const unchecked = (step: WorkflowFacts["calls"][number]): StepStop[] => [
    {
      step: oneLine(step.name),
      guardrail: "",
      outcome: "require_approval",
      checked: true,
      unavailable: true
    }
  ];
  // Each slot starts conservatively and is replaced only when its complete check answers.
  // A late check cannot change the returned warnings or start another check after the deadline.
  const results = facts.calls.map(unchecked);
  let next = 0;
  let expired = false;
  const check = async (step: WorkflowFacts["calls"][number]): Promise<StepStop[]> => {
    const stops: StepStop[] = [];
    const definition = definitions.get(step.operation);
    if (!definition) return [];
    const parsed = await definition.inputSchema.safeParseAsync(step.input).catch(() => undefined);
    if (expired) return unchecked(step);
    if (!parsed) return unchecked(step);
    // Literal inputs use the same parsed value as runtime. References have no value until
    // the run; constant resources (Connections, stores, child Workflows) can still name it.
    if (!parsed.success && !step.dynamic) return unchecked(step);
    const input = !step.dynamic && parsed.success ? parsed.data : step.input;
    const resource = definition.resource(input);
    const call = {
      input,
      origin: { kind: "workflow" as const, workflowRunId: "publish-preview", stepRunId: step.id },
      workspaceId: operationWorkspace({}, resource)
    };
    const met: Awaited<ReturnType<GuardrailRunner["preview"]>> = [];
    const result = await resolveGuardedPolicy({
      definition,
      call,
      resource,
      runtime: {},
      deps: {
        policy: options.policy ?? {
          instanceDefaults: { reading: "allow", changing: "confirm" },
          centralSettings: () => []
        }
      },
      emit: async (event, _phase, _payload, before = {}) => {
        if (expired || !isGuardrailEvent(event) || !guardrails) return PLATFORM_EVENT_ALLOW;
        const answers = await guardrails.preview(
          {
            event,
            match: guardrailMatch({ ...call, filterBy: before.filterBy }),
            aboutGuardrails: before.aboutGuardrails,
            subject:
              before.subject ??
              (resource
                ? { kind: resource.kind, id: resource.id }
                : { kind: "operation", id: definition.name }),
            fields: async () => (await before.checkable?.()) ?? {}
          },
          step.dynamic
        );
        met.push(...answers);
        return {
          outcome: strictestOutcome(answers.map((answer) => answer.outcome)),
          guardrails: answers
        };
      }
    });
    for (const guardrail of met) {
      if (guardrail.outcome !== "require_approval" && guardrail.outcome !== "block") continue;
      stops.push({
        step: oneLine(step.name),
        guardrail: oneLine(guardrail.displayName),
        outcome: guardrail.outcome,
        checked: guardrail.checked
      });
    }
    const { policy } = result;
    if (policy.source !== "guardrail" && policy.next !== "run") {
      stops.push({
        step: oneLine(step.name),
        guardrail: "",
        source: policy.source,
        outcome: policy.value === "deny" ? "block" : "require_approval",
        checked:
          step.dynamic &&
          (definition.policyFloorOf !== undefined || definition.policyTargets !== undefined)
      });
    }
    return stops;
  };
  const worker = async () => {
    while (!expired && Date.now() < deadline && next < facts.calls.length) {
      const index = next++;
      const step = facts.calls[index];
      if (!step) return;
      const checked = await check(step);
      if (!expired) results[index] = checked;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(Array.from({ length: NARRATION_CHECK_CONCURRENCY }, worker)),
      new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            expired = true;
            resolve();
          },
          Math.max(0, deadline - Date.now())
        );
      })
    ]);
    return results.flat();
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

async function narrateApp(
  options: PublishNarratorOptions,
  input: PublishNarrateInput,
  facts: AppFacts
): Promise<PublishNarrative> {
  const names = namers(options, input.access, input.locale);
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
        ...(input.audienceLabel ? { audienceLabel: input.audienceLabel } : {}),
        ...(stored?.audience ? { audience: audienceOnOneLine(stored.audience, workspace) } : {}),
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
