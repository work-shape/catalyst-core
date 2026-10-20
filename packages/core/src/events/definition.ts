import type { JsonObject } from "../json";

export type PlatformEventPhase = "before" | "after";

export interface PlatformEventDefinition {
  name: string;
  /** The kind of subject whose id is supplied when emitting. */
  subject: string;
  /** A reference-only JSON Schema. EW-1 supplies schemas for legacy metadata. */
  payload?: JsonObject;
  legacy: boolean;
  audited: boolean;
  phases: readonly PlatformEventPhase[];
}

/** The shape of the events kept from before EW-1: audited after the action, no payload schema. */
export const LEGACY_AUDIT = { legacy: true, audited: true, phases: ["after"] } as const;

/** The shape of an audited event about a config asset, after the action. */
export const LIVE_ONCE_AUDIT = {
  subject: "config_asset",
  legacy: false,
  audited: true,
  phases: ["after"]
} as const;

type Joined<Groups extends readonly object[]> = Groups extends readonly [
  infer First,
  ...infer Rest extends readonly object[]
]
  ? First & Joined<Rest>
  : unknown;

/**
 * The events of every domain as one map. Each domain declares its events in a file of its own,
 * so a new event edits only its domain's file; a name declared by two domains stops the process
 * when this module loads.
 */
export function joinEvents<Groups extends readonly Record<string, PlatformEventDefinition>[]>(
  ...groups: Groups
): Joined<Groups>;
export function joinEvents(
  ...groups: readonly Record<string, PlatformEventDefinition>[]
): Record<string, PlatformEventDefinition> {
  const joined: Record<string, PlatformEventDefinition> = {};
  for (const group of groups) {
    for (const [name, definition] of Object.entries(group)) {
      if (Object.hasOwn(joined, name)) {
        throw new Error(`The event '${name}' is declared twice`);
      }
      joined[name] = definition;
    }
  }
  return joined;
}
