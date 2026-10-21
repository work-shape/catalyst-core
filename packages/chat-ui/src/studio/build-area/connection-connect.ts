import type { ConnectionDetail, ConnectionTestResult } from "@work-shape/catalyst-api-client";
import { PendingApprovalError } from "./build-refusals";
import { addressOrigin, DISCOVERY_WAIT_MS } from "./connection-form-model";

// What "Verbinden" in the New connection dialog does: operations that exist already, each
// with its own rights, policy and audit, in one order. `assets.put` with no operation
// accepted, `connections.set_secret`, `connections.test` and, for an MCP server,
// `connections.discover` and a read of the detail until the tools are in. There is no server
// operation of its own. The key is sent through `set_secret` alone and kept by the dialog
// until it closes, so a fix of the address sends it again without it being typed again.

/** The calls a connect makes, on the Connection the dialog names. */
export interface ConnectCalls {
  /** Writes the definition: creates it at `null`, or writes over the revision given. */
  put(config: Record<string, unknown>, expectedRevision: number | null): Promise<number>;
  /** Enters the key over the version given, for the Connection at the revision given. */
  setSecret(value: string, expectedVersion: number | null, expectedRevision: number): Promise<void>;
  readDetail(): Promise<ConnectionDetail>;
  /** Throws `PendingApprovalError` where somebody approves the test first. */
  test(): Promise<ConnectionTestResult>;
  /** Throws `PendingApprovalError` where somebody approves the discovery first. */
  discover(): Promise<void>;
  /** Waits between two reads of the detail. */
  pause(ms: number): Promise<void>;
  now(): number;
}

/** What the dialog keeps of its earlier connects, so a second one picks up where it stands. */
export interface ConnectMemory {
  /** The revision the dialog wrote last. Absent until the Connection exists. */
  revision?: number;
  /** The key and the address it was sent for, as far as the dialog sent one. */
  sent?: { key: string; origin: string | undefined };
}

/** The steps the dialog shows while it connects. */
export type ConnectStep = "server" | "key" | "tools";
export type ConnectStepState = "queued" | "running" | "done" | "failed";

/** How a connect ended. Each carries what the dialog keeps for the next one. */
export type ConnectOutcome =
  | {
      status: "connected";
      memory: ConnectMemory;
      /** For an MCP server: its state with the tools discovery read, or without them at the wait's end. */
      detail?: ConnectionDetail;
    }
  /** The test failed: the field it is about says why. */
  | {
      status: "refused";
      memory: ConnectMemory;
      reason: Exclude<ConnectionTestResult["status"], "ready">;
    }
  /** A call waits for somebody's approval in the Inbox. */
  | { status: "held"; memory: ConnectMemory }
  /** The definition was refused: the error of `assets.put`. */
  | { status: "write_failed"; memory: ConnectMemory; error: unknown }
  /** The key was refused by the instance, not by the server: the error of `set_secret`. */
  | { status: "secret_failed"; memory: ConnectMemory; error: unknown };

/** How often the dialog reads the detail while the tools of an MCP server are read. */
const DISCOVERY_READ_MS = 1_000;

export async function connectConnection(
  calls: ConnectCalls,
  attempt: {
    config: Record<string, unknown>;
    url: string;
    key: string;
    discovers: boolean;
    /**
     * What the key is bound to, where more than the address's origin: a REST API's client
     * secret is bound to its authorization server too. Left out, the origin of `url`.
     */
    origin?: string;
  },
  before: ConnectMemory,
  onStep: (step: ConnectStep, state: ConnectStepState) => void
): Promise<ConnectOutcome> {
  let memory = before;
  onStep("server", "running");
  let revision: number;
  try {
    revision = await calls.put(attempt.config, memory.revision ?? null);
  } catch (error) {
    onStep("server", "failed");
    return error instanceof PendingApprovalError
      ? { status: "held", memory }
      : { status: "write_failed", memory, error };
  }
  const created = memory.revision === undefined;
  memory = { ...memory, revision };

  const origin = attempt.origin ?? addressOrigin(attempt.url);
  // A key typed anew, or the old one for a new address: the instance dropped the stored key
  // when the address moved to another host.
  const sends =
    attempt.key !== "" && (memory.sent?.key !== attempt.key || memory.sent.origin !== origin);
  if (sends) {
    try {
      // A new Connection holds no key yet. On a later connect the version is read first, as a
      // write over somebody else's version is refused.
      const version = created ? undefined : (await calls.readDetail()).secret.version;
      // The key is for the definition just written: one written over it since refuses it.
      await calls.setSecret(attempt.key, version ?? null, revision);
    } catch (error) {
      onStep("server", "failed");
      return { status: "secret_failed", memory, error };
    }
    memory = { ...memory, sent: { key: attempt.key, origin } };
  }

  let result: ConnectionTestResult;
  try {
    result = await calls.test();
  } catch (error) {
    if (error instanceof PendingApprovalError) return { status: "held", memory };
    onStep("server", "failed");
    return { status: "write_failed", memory, error };
  }
  if (result.status === "unauthorized") {
    onStep("server", "done");
    onStep("key", "failed");
    // The server refused the key: it is typed anew, and sent again.
    return { status: "refused", memory: { ...memory, sent: undefined }, reason: "unauthorized" };
  }
  if (result.status !== "ready") {
    onStep("server", "failed");
    return { status: "refused", memory, reason: result.status };
  }
  onStep("server", "done");
  if (attempt.key !== "") onStep("key", "done");
  if (!attempt.discovers) return { status: "connected", memory };

  onStep("tools", "running");
  // The tools are in once the detail names a discovery later than the one it named before.
  const earlier = (await calls.readDetail().catch(() => undefined))?.discoveredAt;
  try {
    await calls.discover();
  } catch (error) {
    if (error instanceof PendingApprovalError) return { status: "held", memory };
    onStep("tools", "failed");
    return { status: "connected", memory };
  }
  const since = calls.now();
  for (;;) {
    const detail = await calls.readDetail().catch(() => undefined);
    if (detail?.discoveredAt !== undefined && detail.discoveredAt !== earlier) {
      onStep("tools", "done");
      return { status: "connected", memory, detail };
    }
    if (calls.now() - since >= DISCOVERY_WAIT_MS) {
      onStep("tools", "failed");
      return { status: "connected", memory, ...(detail ? { detail } : {}) };
    }
    await calls.pause(DISCOVERY_READ_MS);
  }
}
