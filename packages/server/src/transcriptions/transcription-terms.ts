import { resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type AccessResource,
  type ActorAccess,
  type CollaborationWorkspace,
  type ConfigAssetRecord,
  type LocaleCode,
  type Project
} from "@work-shape/catalyst-core";
import { getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import type { ChatServerOptions } from "../types";

/** The most terms one transcription sends: what Mistral reads for context biasing. */
const TRANSCRIPTION_MAX_TERMS = 100;

/** The most assets of one kind whose names a request reads. */
const ASSETS_READ_PER_KIND = 200;

/** Where the recording is spoken, as far as the request says and the person may see it. */
export interface TranscriptionPlace {
  /** The workspace the composer is in; absent where the request names none. */
  workspace?: CollaborationWorkspace;
  project?: Project;
  /** The person reads the chat from outside its workspace (CHAT-SHARE-6). */
  outside?: boolean;
}

/**
 * The words sent with a recording (STT-1), built per request from what the person can already
 * see, the release's own terms first, cut at {@link TRANSCRIPTION_MAX_TERMS}: the release's
 * `transcription.terms`, the shared workspace's name and the project's title, then the agents
 * the person may use there and the Knowledge Bases and Data Stores they may read. Context
 * biasing only: nothing is trained on them, and none is stored or logged.
 */
export async function transcriptionTerms(
  options: Pick<
    ChatServerOptions,
    "config" | "clientInstanceId" | "configAssets" | "modules" | "stores"
  >,
  input: { access: ActorAccess; locale: LocaleCode; place: TranscriptionPlace }
): Promise<string[]> {
  const { access, locale, place } = input;
  const fallbackLocale = options.config.localization.defaultLocale;
  const workspaceRef = place.workspace
    ? { kind: place.workspace.kind, id: place.workspace.id }
    : { kind: "personal" as const };
  const [assets, knowledgeBases, dataStores] = await Promise.all([
    getWorkspaceAssetSnapshot(options, workspaceRef, access, {
      ...(place.outside ? { outside: true } : {})
    }),
    // An outside reader reaches the workspace through the chat alone: no more names than that.
    place.outside || !options.modules.isEnabled("knowledge")
      ? []
      : readableTitles(options, access, KNOWLEDGE_BASE_ASSET_KIND, [
          KNOWLEDGE_BASE_ACTIONS.read,
          KNOWLEDGE_BASE_ACTIONS.use
        ]),
    place.outside || !options.modules.isEnabled("dataStores")
      ? []
      : readableTitles(options, access, DATA_STORE_ASSET_KIND, [DATA_STORE_ACTIONS.read])
  ]);
  const agents = assets.agents.map(
    (agent) => resolveLocalizedString(agent.displayName, locale, fallbackLocale) ?? agent.name
  );
  return distinctTerms([
    ...options.config.transcription.terms,
    ...(place.workspace?.kind === "shared" ? [place.workspace.name] : []),
    ...(place.project ? [place.project.title] : []),
    ...agents,
    ...knowledgeBases,
    ...dataStores
  ]);
}

/** The titles of the published assets of a kind that the person holds one of the rights on. */
async function readableTitles(
  options: Pick<ChatServerOptions, "clientInstanceId" | "configAssets">,
  access: ActorAccess,
  kind: string,
  rights: readonly string[]
): Promise<string[]> {
  const records = await options.configAssets.store.listPublishedConfigAssets({
    clientInstanceId: options.clientInstanceId,
    kind,
    limit: ASSETS_READ_PER_KIND
  });
  return records
    .filter(
      (record) =>
        record.status === "active" &&
        rights.some((right) => access.authorize(right, resourceOf(record)).allowed)
    )
    .map(titleOf);
}

function resourceOf(record: ConfigAssetRecord): AccessResource {
  return {
    kind: record.kind,
    name: record.name,
    assetId: record.id,
    ...(record.scope.kind === "workspace" ? { workspaceId: record.scope.workspaceId } : {})
  };
}

function titleOf(record: ConfigAssetRecord): string {
  const title = record.personTitle ?? record.publishedConfig?.title ?? record.config?.title;
  return typeof title === "string" && title.trim() !== "" ? title : record.name;
}

/** Each term once, as first named, trimmed, without empty ones, at most the maximum. */
function distinctTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    const key = term.toLocaleLowerCase();
    if (term === "" || seen.has(key)) continue;
    seen.add(key);
    kept.push(term);
    if (kept.length === TRANSCRIPTION_MAX_TERMS) break;
  }
  return kept;
}
