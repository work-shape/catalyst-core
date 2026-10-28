import {
  DATA_STORE_OPERATION_PREFIX,
  dataStoreOperationName,
  type DataStoreOperationVerb
} from "@work-shape/catalyst-core";
import type { TranslationContextValue } from "../../shared/i18n";
import type { AssetPlace } from "./asset-place";

// AGENT-DATA-1: an agent is given a Data Store on its page as one of two kinds of access, and
// the page writes it as the store's row tools in the agent's tool list, the names the runtime
// already offers (`data_store.<store>.<verb>`). There is no other record of it. The person in
// the chat still needs the right on the store for each call.

/** What an agent may do with one Data Store: read its rows, or read and change them. */
export type DataStoreAccess = "read" | "change";

/** The verbs "read" gives: the store's tables, a query and the first rows of a table. */
const READ_VERBS = [
  "describe",
  "query",
  "preview_rows"
] as const satisfies readonly DataStoreOperationVerb[];
/** The verbs "change" adds: add, change and remove rows. */
export const DATA_STORE_CHANGE_VERBS = [
  "insert",
  "update",
  "delete_rows"
] as const satisfies readonly DataStoreOperationVerb[];
const AGENT_VERBS: readonly string[] = [...READ_VERBS, ...DATA_STORE_CHANGE_VERBS];

/** One Data Store an agent holds tools of, with the access they add up to. */
export interface HeldDataStore {
  store: string;
  access: DataStoreAccess;
}

/**
 * The store a tool name is a row tool of, where it is one of the six the page sets. Other verbs
 * of a store, such as `load`, are not the page's and stay in the Tools section by their name.
 */
function storeOfAgentTool(name: string): string | undefined {
  if (!name.startsWith(DATA_STORE_OPERATION_PREFIX)) return undefined;
  const rest = name.slice(DATA_STORE_OPERATION_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return undefined;
  return AGENT_VERBS.includes(rest.slice(dot + 1)) ? rest.slice(0, dot) : undefined;
}

/** Whether a tool is one the Data section sets: it is shown there, not under Tools. */
export function isAgentDataStoreToolName(name: string): boolean {
  return storeOfAgentTool(name) !== undefined;
}

/**
 * The stores an agent holds row tools of, in the order it first names them. A store with any
 * tool that changes rows is "change"; one with only reading tools is "read", also where it
 * lists fewer than all three.
 */
export function heldDataStores(toolNames: readonly string[]): HeldDataStore[] {
  const held = new Map<string, DataStoreAccess>();
  for (const name of toolNames) {
    const store = storeOfAgentTool(name);
    if (store === undefined) continue;
    const verb = name.slice(DATA_STORE_OPERATION_PREFIX.length + store.length + 1);
    const changes = (DATA_STORE_CHANGE_VERBS as readonly string[]).includes(verb);
    held.set(store, changes || held.get(store) === "change" ? "change" : "read");
  }
  return [...held].map(([store, access]) => ({ store, access }));
}

/** The tool names one kind of access to one store is written as. */
function dataStoreToolNames(store: string, access: DataStoreAccess): string[] {
  return (access === "change" ? [...READ_VERBS, ...DATA_STORE_CHANGE_VERBS] : READ_VERBS).map(
    (verb) => dataStoreOperationName(store, verb)
  );
}

/**
 * The tool list with one store's access set, or taken away with `undefined`. The store's tools
 * take the place of its first one, so the other tools keep their order; a store it did not hold
 * goes last. Every other tool stays as it was.
 */
export function withDataStoreAccess(
  toolNames: readonly string[],
  store: string,
  access: DataStoreAccess | undefined
): string[] {
  const at = toolNames.findIndex((name) => storeOfAgentTool(name) === store);
  const others = toolNames.filter((name) => storeOfAgentTool(name) !== store);
  if (access === undefined) return others;
  const own = dataStoreToolNames(store, access);
  if (at < 0) return [...others, ...own];
  const before = toolNames.slice(0, at).filter((name) => storeOfAgentTool(name) !== store).length;
  return [...others.slice(0, before), ...own, ...others.slice(before)];
}

/**
 * The tool list with the stores chosen in the picker: a newly chosen one reads, one left out is
 * taken away, and those kept keep their access.
 */
export function withChosenDataStores(
  toolNames: readonly string[],
  chosen: readonly string[]
): string[] {
  const held = heldDataStores(toolNames).map((entry) => entry.store);
  let next = [...toolNames];
  for (const store of held) {
    if (!chosen.includes(store)) next = withDataStoreAccess(next, store, undefined);
  }
  for (const store of chosen) {
    if (!held.includes(store)) next = withDataStoreAccess(next, store, "read");
  }
  return next;
}

/**
 * Why an agent cannot use a store the reader sees: where the store sits, then that an agent of
 * the agent's place cannot use it. The server refuses such a reference (one owner check).
 */
export function unusableDataStoreReason(
  store: AssetPlace,
  agent: AssetPlace,
  t: TranslationContextValue["t"]
): string {
  const where =
    store.rung === "mine"
      ? t("dataStores.agentOnlyMine")
      : t("dataStores.agentInWorkspace", { workspace: store.name });
  const cannot =
    agent.rung === "all"
      ? t("dataStores.agentCannotAll")
      : agent.rung === "mine"
        ? t("dataStores.agentCannotMine")
        : t("dataStores.agentCannotIn", { workspace: agent.name });
  return `${where} ${cannot}`;
}
