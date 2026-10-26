import { isRecord } from "./json";
import type { AgentConfig } from "./config";

/**
 * An agent that ships with the platform, such as Workshaper. The release seed stores it on
 * every instance whose module for it is on, available in no workspace until an admin offers it,
 * and refreshes it with each release. The instance may change it like any agent of its own: a
 * field it changed stays the instance's, one it left as shipped takes what the release ships.
 * Its name is the platform's, also where the module is off, and it cannot be deleted.
 */
export type ShippedAgent = Pick<
  AgentConfig,
  "name" | "displayName" | "instructions" | "toolNames" | "skillNames" | "initialPrompts"
> &
  Partial<Pick<AgentConfig, "description" | "welcomeMessage">>;

/**
 * The fields a release ships of an agent and refreshes where the instance kept them. The model
 * and everything else are the instance's alone.
 */
export const SHIPPED_AGENT_FIELDS = [
  "displayName",
  "description",
  "welcomeMessage",
  "instructions",
  "toolNames",
  "skillNames",
  "initialPrompts"
] as const;

export type ShippedAgentField = (typeof SHIPPED_AGENT_FIELDS)[number];

/** The fields that hold names, which merge as sets rather than as one value. */
const SET_FIELDS: ReadonlySet<ShippedAgentField> = new Set(["toolNames", "skillNames"]);

export function isShippedAgentSetField(field: ShippedAgentField): boolean {
  return SET_FIELDS.has(field);
}

/** The fields of a shipped agent as the agent's definition holds them under `shipped`. */
export function shippedAgentFields(agent: ShippedAgent): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of SHIPPED_AGENT_FIELDS) {
    const value = agent[field];
    if (value !== undefined) fields[field] = value;
  }
  return fields;
}

/**
 * What the agent becomes when a release ships `next`: a three-way merge against what the
 * release before shipped (`stored.shipped`), field by field. A field the instance left as
 * shipped takes the new value; one it changed keeps the instance's. Names merge as sets: what
 * the release ships, less what the instance removed since, with what the instance added.
 * Every field the release does not ship stays as stored, and `shipped` records `next`.
 */
export function mergeShippedAgent(
  stored: Record<string, unknown>,
  next: ShippedAgent,
  equal: (left: unknown, right: unknown) => boolean
): Record<string, unknown> {
  const base = isRecord(stored.shipped) ? stored.shipped : {};
  const shipped = shippedAgentFields(next);
  const merged: Record<string, unknown> = { ...stored };
  for (const field of SHIPPED_AGENT_FIELDS) {
    const value = SET_FIELDS.has(field)
      ? mergeNames(names(base[field]), names(stored[field]), names(shipped[field]))
      : equal(stored[field], base[field])
        ? shipped[field]
        : stored[field];
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  merged.shipped = shipped;
  return merged;
}

function mergeNames(
  base: readonly string[],
  current: readonly string[],
  next: readonly string[]
): string[] {
  const removed = new Set(base.filter((name) => !current.includes(name)));
  const added = current.filter((name) => !base.includes(name) && !next.includes(name));
  return [...next.filter((name) => !removed.has(name)), ...added];
}

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}
