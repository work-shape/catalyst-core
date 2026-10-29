import {
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  dataHandoverGaps,
  dataHandoverLines,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  requireDataHandover,
  type ActorAccess,
  type AppAudience,
  type AppAvailability,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type DataHandoverAnswer,
  type DataHandoverPublish,
  type LocaleCode
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { recordAssetEvent } from "./asset-target";
import type { AssetCall } from "./asset-access";

// The widening check of a publish (DS-13c), on the server and inside the publish: the asset and
// every Workflow published with an App are asked as they would be live, for the caller. The
// publish question shows its answer; the publish itself asks it again and refuses a hand-over
// nobody confirmed. The check itself is the stored-data module's (`DataHandover`).

/** The kinds whose publish can change who reads a store or where its rows come from. */
const CHECKED_KINDS: readonly string[] = ["app", WORKFLOW_ASSET_KIND, KNOWLEDGE_BASE_ASSET_KIND];

/** One publish as the check reads it: the asset, and the Workflows an App makes live with it. */
export interface HandoverPublishInput {
  kind: string;
  name: string;
  revision: number;
  audience?: AppAudience;
  workflows?: readonly { name: string; revision: number }[] | undefined;
}

/**
 * Who may use an App once published: the audience chosen, or the live one, or Only me for a
 * first publish, as the publish decides it (`prepareAppPublication`).
 */
function appAvailabilityOf(
  asset: ConfigAssetRecord,
  chosen: AppAudience | undefined,
  actor: AuthenticatedIdentity
): AppAvailability {
  const audience =
    chosen ??
    (asset.publishedRevisionId ? (asset.appAvailability?.audience ?? "workspace") : "self");
  if (audience !== "self") return { audience };
  const userId =
    chosen === undefined && asset.publishedRevisionId && asset.appAvailability?.userId
      ? asset.appAvailability.userId
      : isAuthenticatedServicePrincipal(actor)
        ? undefined
        : getSubjectUserId(actor);
  return { audience, ...(userId ? { userId } : {}) };
}

/**
 * The widening check of one publish for its caller, or nothing where the stored-data module is
 * off or the publish changes no reader and no source of a store.
 */
async function checkPublishHandover(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "operationCalls">,
  call: { actor: AuthenticatedIdentity; access: ActorAccess },
  input: HandoverPublishInput
): Promise<DataHandoverAnswer | undefined> {
  const handover = options.operationCalls?.dataHandover;
  if (!handover || !CHECKED_KINDS.includes(input.kind)) return undefined;
  const { clientInstanceId } = options;
  const store = options.configAssets.store;
  const revisionOf = async (
    kind: string,
    name: string,
    revision: number
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
        ? { appAvailability: appAvailabilityOf(asset, input.audience, call.actor) }
        : {})
    };
  };
  const publishing = (
    await Promise.all([
      revisionOf(input.kind, input.name, input.revision),
      ...(input.kind === "app" ? (input.workflows ?? []) : []).map((workflow) =>
        revisionOf(WORKFLOW_ASSET_KIND, workflow.name, workflow.revision)
      )
    ])
  ).filter((item): item is DataHandoverPublish => item !== undefined);
  if (publishing.length === 0) return undefined;
  return handover.check(call.access, publishing);
}

/**
 * Refuses a publish that hands a source's data on without the confirmation of a holder of
 * `connection.write` on it, and answers the check otherwise.
 */
export async function requirePublishHandover(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "operationCalls">,
  call: { actor: AuthenticatedIdentity; access: ActorAccess },
  input: HandoverPublishInput & { confirmHandover?: string | undefined }
): Promise<DataHandoverAnswer | undefined> {
  const answer = await checkPublishHandover(options, call, input);
  if (answer) requireDataHandover(answer, input.confirmHandover);
  return answer;
}

/** Records each hand-over a publish made with its caller's confirmation: how many, never who. */
export async function recordPublishHandover(
  call: AssetCall,
  input: Pick<HandoverPublishInput, "kind" | "name">,
  answer: DataHandoverAnswer | undefined
): Promise<void> {
  for (const gap of answer ? dataHandoverGaps(answer) : []) {
    await recordAssetEvent(call, "data_store.handover_confirmed", {
      store: gap.store.name,
      connection: gap.connection.name,
      people: gap.newlyLacking,
      kind: input.kind,
      name: input.name
    });
  }
}

/** What the publish question says of the check, in the reader's language. */
export async function publishHandoverQuestion(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "operationCalls">,
  call: { actor: AuthenticatedIdentity; access: ActorAccess },
  input: HandoverPublishInput,
  locale: LocaleCode
): Promise<{ holds: boolean; lines: string[]; confirmation?: string } | undefined> {
  const answer = await checkPublishHandover(options, call, input);
  if (!answer || answer.pairs.length === 0) return undefined;
  const { holds, lines } = dataHandoverLines(answer, locale);
  // The confirmation is offered only to who may give it.
  const mayConfirm = dataHandoverGaps(answer).every((gap) => gap.mayConfirm);
  return {
    holds,
    lines,
    ...(answer.confirmation && mayConfirm ? { confirmation: answer.confirmation } : {})
  };
}
