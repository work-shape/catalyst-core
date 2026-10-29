import {
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  confirmsAsPerson,
  dataHandoverGaps,
  dataHandoverLines,
  dataHandoverMayConfirm,
  dataHandoverRights,
  dataHandoverSubject,
  dataHandoverSubjectConfirmation,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  requireDataHandover,
  type ActorAccess,
  type AgentAvailability,
  type AppAudience,
  type AppAvailability,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type DataHandoverAnswer,
  type DataHandoverPublish,
  type JsonObject,
  type LocaleCode,
  type OperationApproval,
  type OperationOrigin,
  type PolicyValue
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { readDefinitionName } from "../asset-kinds/shared";
import type { AssetCall } from "./asset-access";
import { withGivenTools } from "./agent-drafts";
import { dependencyAvailabilityChanges } from "./agent-dependency-availability";
import type { AssetSyncInput } from "./asset-sync-refusals";
import { toJsonObject } from "./asset-write-rules";

const AGENT_KIND = "agent";

// The widening check (DS-13c), on the server and inside each change that can widen who reads a
// store's rows or add a source to it: a publish of an App (with the Workflows it makes live), a
// Workflow, a Knowledge Base or an agent; a Knowledge Base's availability; a move to a wider
// owner; an agent made with its tools or given tools, and the Knowledge Bases an agent's consent
// offers where it is offered. The check itself is the stored-data module's (`DataHandover`);
// this is how a change is held for it. A change that hands a source's data on waits in the Inbox for an approval that
// asks `connection.write` on each source of who decides it, a person; that approval is the
// confirmation. A person in the interface who holds `connection.write` confirms it with the
// change itself. A key, a service principal, an agent and an embedding host never confirm.
// No policy turns the wait off: the floor is `approval` while a hand-over is unconfirmed.

/** What a change the widening check guards carries: the confirmation of a person. */
export interface HandoverConfirmed {
  /** The confirmation the question named (`confirmation` of the answer). */
  confirmHandover?: string | undefined;
}

/** Who makes a change, as the check reads the call. */
interface HandoverCaller {
  actor: AuthenticatedIdentity;
  access: ActorAccess;
  origin: Pick<OperationOrigin, "kind">;
}

/** How a change was confirmed, as its audit row says. */
type HandoverConfirmedBy = { by: "caller" } | { by: "approver"; approverId: string };

type GateOptions = Pick<
  AssetWorkflowOptions,
  "clientInstanceId" | "configAssets" | "operationCalls" | "stores" | "logger"
>;

/** The assets one call changes, as the check is asked about them; nothing for none. */
export type HandoverChanges<I> = (
  input: I,
  actor: AuthenticatedIdentity | undefined
) => Promise<readonly DataHandoverPublish[] | undefined>;

/**
 * The widening check of one operation: asked when the call is authorized, as the floor of its
 * policy, in the approval it waits for, and again as it is executed.
 */
export class DataHandoverGate<I extends HandoverConfirmed> {
  constructor(
    private readonly options: GateOptions,
    private readonly changes: HandoverChanges<I>
  ) {}

  /** The check of the call's change for `access`, or nothing where it changes no store. */
  async answer(
    access: ActorAccess | undefined,
    input: I,
    actor: AuthenticatedIdentity | undefined
  ): Promise<DataHandoverAnswer | undefined> {
    const handover = this.options.operationCalls?.dataHandover;
    if (!handover) return undefined;
    const changes = await this.changes(input, actor);
    if (!changes?.length) return undefined;
    return handover.check(access, changes);
  }

  /**
   * Refuses a confirmation the caller may not give, up front: from a key, a service
   * principal, an agent or an embedding host; from who holds no `connection.write` on a
   * source; or of another hand-over. A call without one passes: the floor holds it.
   */
  async authorize(caller: HandoverCaller, input: I): Promise<void> {
    if (input.confirmHandover === undefined) return;
    const answer = await this.answer(caller.access, input, caller.actor);
    if (answer)
      requireDataHandover(answer, input.confirmHandover, {
        person: confirmsAsPerson(caller.actor, caller.origin)
      });
  }

  /**
   * The floor of the call: an approval while it hands a source's data on unconfirmed, whatever
   * a central setting says. A confirmation `authorize` let through keeps the floor it had.
   */
  async policyFloor(
    input: I,
    actor: AuthenticatedIdentity | undefined,
    floor: PolicyValue | undefined
  ): Promise<PolicyValue | undefined> {
    if (floor === "deny" || floor === "approval") return floor;
    const answer = await this.answer(undefined, input, actor);
    if (answer?.confirmation === undefined || input.confirmHandover === answer.confirmation)
      return floor;
    return "approval";
  }

  /**
   * The approval the call waits for, with the hand-over in its subject: who decides it holds
   * `connection.write` on each source, and the caller's own click approves it only where they
   * do. A call without an approval of its own waits for the approvers of operations.
   */
  async approval(
    input: I,
    actor: AuthenticatedIdentity | undefined,
    own: OperationApproval | undefined
  ): Promise<OperationApproval | undefined> {
    const answer = await this.answer(undefined, input, actor);
    const handover = answer ? dataHandoverSubject(answer) : undefined;
    if (!handover) return own;
    const rights = dataHandoverRights(handover).map(({ permission, resource }) => ({
      action: permission,
      resource
    }));
    if (!own) {
      return {
        kind: "operation_call",
        action: "operations.approve",
        alsoRequires: rights,
        subject: handover
      };
    }
    return {
      ...own,
      alsoRequires: [...(own.alsoRequires ?? []), ...rights],
      subject: { ...own.subject, ...handover }
    };
  }

  /**
   * Asked again as the change is made, with who reads what now: it goes through where the
   * check holds, where its caller is a person who confirmed exactly this hand-over, or where a
   * person who decided its approval confirmed it. It is refused otherwise.
   */
  async execute(
    call: HandoverCaller & { runId?: string | undefined },
    input: I
  ): Promise<{ answer: DataHandoverAnswer; confirmed: HandoverConfirmedBy } | undefined> {
    const answer = await this.answer(call.access, input, call.actor);
    if (answer?.confirmation === undefined) return undefined;
    const person = confirmsAsPerson(call.actor, call.origin);
    if (input.confirmHandover !== undefined) {
      requireDataHandover(answer, input.confirmHandover, { person });
      return { answer, confirmed: { by: "caller" } };
    }
    const approved = await this.approvedConfirmation(call.runId);
    if (approved && approved.confirmation === answer.confirmation)
      return { answer, confirmed: { by: "approver", approverId: approved.by } };
    requireDataHandover(answer, undefined, { person });
    // A hand-over that needs a confirmation is never let through without one.
    throw new Error("A hand-over without a confirmation was let through");
  }

  /** The confirmation a person's approval of the call's run gave, and who that person is. */
  private async approvedConfirmation(
    runId: string | undefined
  ): Promise<{ confirmation: string; by: string } | undefined> {
    if (runId === undefined) return undefined;
    const { clientInstanceId, stores } = this.options;
    const run = await stores.operationRuns.get({ clientInstanceId, id: runId });
    const decision = run?.decision;
    // The caller's own click on a held publish is no approval of the hand-over: they confirm it.
    if (
      decision?.mode !== "approved" ||
      decision.reason === "approved_by_caller" ||
      run?.approvalRequestId === undefined
    )
      return undefined;
    const request = await stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: run.approvalRequestId
    });
    if (request?.decision?.approved !== true || request.decision.decidedBy !== decision.by)
      return undefined;
    const confirmation = dataHandoverSubjectConfirmation(request.payload.subject);
    return confirmation ? { confirmation, by: decision.by } : undefined;
  }

  /**
   * The call with the hand-overs its change confirmed, which the change records in its own
   * transaction (`recordHandover`): how many people, the store and the source, and who
   * confirmed it. Never who receives the data.
   */
  confirming<C extends AssetCall>(
    call: C,
    about: { kind: string; name: string; change: string },
    executed: { answer: DataHandoverAnswer; confirmed: HandoverConfirmedBy } | undefined
  ): C {
    if (!executed) return call;
    const { answer, confirmed } = executed;
    const handover = dataHandoverGaps(answer).map((gap): JsonObject => ({
      store: gap.store.name,
      storeKind: gap.store.kind,
      connection: gap.connection.name,
      people: gap.newlyLacking,
      kind: about.kind,
      name: about.name,
      change: about.change,
      confirmedBy: confirmed.by,
      ...(confirmed.by === "approver" ? { approverId: confirmed.approverId } : {}),
      ...(answer.truncated ? { truncated: true } : {})
    }));
    return handover.length === 0 ? call : { ...call, handover };
  }

  /** What the question before the change says of the check, in the reader's language. */
  async question(
    caller: Omit<HandoverCaller, "origin"> & { origin?: HandoverCaller["origin"] },
    input: I,
    locale: LocaleCode
  ): Promise<{ holds: boolean; lines: string[]; confirmation?: string } | undefined> {
    const answer = await this.answer(caller.access, input, caller.actor);
    if (!answer || (answer.pairs.length === 0 && answer.confirmation === undefined))
      return undefined;
    const { holds, lines } = dataHandoverLines(answer, locale);
    // The confirmation is offered only to who may give it: a person who holds every right.
    const offered =
      answer.confirmation !== undefined &&
      dataHandoverMayConfirm(answer) &&
      confirmsAsPerson(caller.actor, caller.origin ?? { kind: "user" });
    return { holds, lines, ...(offered ? { confirmation: answer.confirmation } : {}) };
  }
}

/** One publish as the check reads it: the asset, and the Workflows an App makes live with it. */
interface HandoverPublishInput extends HandoverConfirmed {
  kind: string;
  name: string;
  revision: number;
  audience?: AppAudience;
  workflows?: readonly { name: string; revision: number }[] | undefined;
  /** Of an agent: its publish offers the Knowledge Bases it uses where it is offered. */
  makeDependenciesAvailable?: boolean | undefined;
}

/**
 * Who may use an App once published: the audience chosen, or the live one, or Only me for a
 * first publish, as the publish decides it (`prepareAppPublication`).
 */
function appAvailabilityOf(
  asset: ConfigAssetRecord,
  chosen: AppAudience | undefined,
  actor: AuthenticatedIdentity | undefined
): AppAvailability {
  const audience =
    chosen ??
    (asset.publishedRevisionId ? (asset.appAvailability?.audience ?? "workspace") : "self");
  if (audience !== "self") return { audience };
  const userId =
    chosen === undefined && asset.publishedRevisionId && asset.appAvailability?.userId
      ? asset.appAvailability.userId
      : actor === undefined || isAuthenticatedServicePrincipal(actor)
        ? undefined
        : getSubjectUserId(actor);
  return { audience, ...(userId ? { userId } : {}) };
}

/** The kinds whose revision a publish makes live from a stored revision. */
const REVISION_KINDS: readonly string[] = ["app", WORKFLOW_ASSET_KIND, KNOWLEDGE_BASE_ASSET_KIND];

/** The agent a change leaves, and the Knowledge Bases its consent offers in more workspaces. */
async function agentChanges(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">,
  agent: { name: string; config: JsonObject; fresh: boolean },
  wanted: AgentAvailability | undefined
): Promise<DataHandoverPublish[]> {
  return [
    {
      kind: AGENT_KIND,
      name: agent.name,
      config: agent.config,
      ...(agent.fresh ? { fresh: true } : {})
    },
    ...(await dependencyAvailabilityChanges(options, agent.config, wanted))
  ];
}

/**
 * The assets one publish makes live, as the check reads them: the revision of an App, a
 * Workflow or a Knowledge Base, each Workflow an App makes live with it, and an agent's draft.
 * An agent that awaits its first publish was live for nobody: each of its sources is new.
 */
function publishChanges(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">,
  agentConfig: (input: HandoverPublishInput) => Promise<JsonObject | undefined>
): HandoverChanges<HandoverPublishInput> {
  const { clientInstanceId } = options;
  const store = options.configAssets.store;
  const revisionOf = async (
    kind: string,
    name: string,
    revision: number,
    input: HandoverPublishInput,
    actor: AuthenticatedIdentity | undefined
  ): Promise<DataHandoverPublish | undefined> => {
    const asset = await store.getConfigAsset({ clientInstanceId, kind, name });
    if (asset?.status !== "active") return undefined;
    const stored = await store.getConfigAssetRevision({ clientInstanceId, kind, name, revision });
    // A revision number outlives a delete and a new asset of the name: it must be this one's.
    if (stored?.assetId !== asset.id) return undefined;
    return {
      kind,
      name,
      config: stored.config ?? null,
      ...(kind === "app"
        ? { appAvailability: appAvailabilityOf(asset, input.audience, actor) }
        : {})
    };
  };
  return async (input, actor) => {
    if (input.kind === AGENT_KIND) {
      const config = await agentConfig(input);
      if (!config) return undefined;
      const fresh = await store.agentAwaitsFirstPublish({
        clientInstanceId,
        agentName: input.name
      });
      // The consent offers its Knowledge Bases where the agent is offered (`publishAgentDraft`).
      const wanted = input.makeDependenciesAvailable
        ? (await store.listAgentAvailability({ clientInstanceId, agentName: input.name })).get(
            input.name
          )
        : undefined;
      return agentChanges(options, { name: input.name, config, fresh }, wanted);
    }
    if (!REVISION_KINDS.includes(input.kind)) return undefined;
    const changes = await Promise.all([
      revisionOf(input.kind, input.name, input.revision, input, actor),
      ...(input.kind === "app" ? (input.workflows ?? []) : []).map((workflow) =>
        revisionOf(WORKFLOW_ASSET_KIND, workflow.name, workflow.revision, input, actor)
      )
    ]);
    return changes.filter((change): change is DataHandoverPublish => change !== undefined);
  };
}

/** An availability as a call names it. */
function availabilityOf(input: {
  mode: AgentAvailability["mode"];
  personalWorkspaces?: boolean;
  collaborationWorkspaceIds?: readonly string[];
}): AgentAvailability {
  const selected = input.mode === "selected";
  return {
    mode: input.mode,
    personalWorkspaces: selected && input.personalWorkspaces === true,
    collaborationWorkspaceIds: selected
      ? (input.collaborationWorkspaceIds ?? []).map(asCollaborationWorkspaceId)
      : []
  };
}

/**
 * A Knowledge Base offered in other workspaces, as the check reads it, and the Knowledge Bases
 * an agent's consent offers where the agent is offered (`makeDependenciesAvailable`).
 */
export function availabilityChanges(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">
): HandoverChanges<
  HandoverConfirmed & {
    kind: string;
    name: string;
    mode: AgentAvailability["mode"];
    personalWorkspaces?: boolean;
    collaborationWorkspaceIds?: string[];
    makeDependenciesAvailable?: boolean;
  }
> {
  return async (input) => {
    if (input.kind === KNOWLEDGE_BASE_ASSET_KIND)
      return [{ kind: input.kind, name: input.name, availability: availabilityOf(input) }];
    if (input.kind !== AGENT_KIND || !input.makeDependenciesAvailable) return undefined;
    const agent = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: AGENT_KIND,
      name: input.name
    });
    if (agent?.status !== "active") return undefined;
    return dependencyAvailabilityChanges(options, agent.config, availabilityOf(input));
  };
}

/** Whether an agent of the name is live: a write of it is its draft then, not a new agent. */
async function agentExists(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">,
  name: string
): Promise<boolean> {
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: AGENT_KIND,
    name
  });
  return asset?.status === "active";
}

/**
 * An agent a write makes (`assets.put`), as the check reads it: it is live at once with its
 * tools, none of them there before, and its consent offers its Knowledge Bases where it starts.
 * A write of an agent that exists is its draft, which the publish asks about.
 */
export function createChanges(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">
): HandoverChanges<
  HandoverConfirmed & {
    kind: string;
    name: string;
    config?: Record<string, unknown> | undefined;
    makeDependenciesAvailable?: boolean | undefined;
    expectedAvailability?:
      | {
          mode: AgentAvailability["mode"];
          personalWorkspaces: boolean;
          collaborationWorkspaceIds: string[];
        }
      | undefined;
  }
> {
  return async (input) => {
    if (input.kind !== AGENT_KIND || input.config === undefined) return undefined;
    if (await agentExists(options, input.name)) return undefined;
    return agentChanges(
      options,
      { name: input.name, config: toJsonObject(input.config), fresh: true },
      input.makeDependenciesAvailable && input.expectedAvailability
        ? availabilityOf(input.expectedAvailability)
        : undefined
    );
  };
}

/** The agents a batch makes (`assets.sync`), each as `createChanges` reads one. */
export function syncChanges(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">
): HandoverChanges<HandoverConfirmed & AssetSyncInput> {
  return async (input) => {
    const changes: DataHandoverPublish[] = [];
    for (const item of input.items) {
      if (item.type !== "put" || item.kind !== AGENT_KIND) continue;
      const name = readDefinitionName(item.config);
      if (!name || (await agentExists(options, name))) continue;
      changes.push({ kind: AGENT_KIND, name, config: toJsonObject(item.config), fresh: true });
    }
    return changes.length > 0 ? changes : undefined;
  };
}

/** The names of the agents a batch writes, as its hand-over's audit row names them. */
export function syncedAgentNames(input: AssetSyncInput): string {
  return input.items
    .flatMap((item) =>
      item.type === "put" && item.kind === AGENT_KIND ? [readDefinitionName(item.config) ?? ""] : []
    )
    .filter((name) => name !== "")
    .join(", ");
}

/** The tools given to the live agent (`agents.give_tools`): what goes live, as the check reads it. */
export function giveToolsChanges(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">
): HandoverChanges<HandoverConfirmed & { name: string; toolNames: readonly string[] }> {
  return async (input) => {
    const agent = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: AGENT_KIND,
      name: input.name
    });
    if (agent?.status !== "active" || !agent.config) return undefined;
    return [
      {
        kind: AGENT_KIND,
        name: input.name,
        config: toJsonObject(withGivenTools(agent.config, input.toolNames))
      }
    ];
  };
}

/** What a question of a publish reads: the asset at the revision asked, for its reader. */
export function publishHandoverGate(
  options: GateOptions,
  agentConfig: (input: HandoverPublishInput) => Promise<JsonObject | undefined>
): DataHandoverGate<HandoverPublishInput> {
  return new DataHandoverGate(options, publishChanges(options, agentConfig));
}
