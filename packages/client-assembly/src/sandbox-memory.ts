import { totalmem } from "node:os";
import { AppError, type Logger, type ModuleSnapshot } from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ClientInstanceEnv } from "./env";

// The command worker starts every sandbox of an instance: the containers of agent commands,
// of Page builds and of the code steps of Workflows. Each kind has slots and a memory limit,
// and all of them can be full at one moment. A config in which they then need more memory
// than the host has is refused when the worker starts, with each term named, so an operator
// sees which number to lower before a full host ends containers at random.

/** What a `docker` sandbox gives a container where the entry names no `memoryBytes`. */
const SANDBOX_DEFAULT_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
/** How many Page builds a worker runs at once where `PAGE_BUILD_CONCURRENCY` is not set. */
const PAGE_BUILD_DEFAULT_SLOTS = 2;

/** One kind of sandbox: how many run at once, what each gets, and where both are set. */
export interface SandboxMemoryTerm {
  kind: string;
  slots: number;
  memoryBytes: number;
  /** The settings an operator lowers: the slots first, the memory second. */
  settings: readonly [string, string];
}

const GIB = 1024 * 1024 * 1024;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(2)} GiB`;

/** A positive whole number of an environment variable, or nothing. */
function positive(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The kinds of sandbox the command worker of this config runs, each with its slots and its
 * memory. None where the sandbox is not `docker`: the `local` sandbox runs commands as
 * processes of the worker, which have no memory limit to add up.
 */
export function sandboxMemoryTerms(input: {
  config: ClientInstanceConfig;
  modules: Pick<ModuleSnapshot, "isEnabled">;
  env: Pick<ClientInstanceEnv, "PAGE_BUILD_CONCURRENCY">;
}): SandboxMemoryTerm[] {
  const { config, modules } = input;
  const { sandbox } = config.infrastructure;
  if (sandbox?.provider !== "docker") return [];
  const own = sandbox.memoryBytes;
  const commandMemory = typeof own === "number" && own > 0 ? own : SANDBOX_DEFAULT_MEMORY_BYTES;
  const terms: SandboxMemoryTerm[] = [
    {
      kind: "workspace commands",
      slots: config.executionWorkspaces.worker.concurrency,
      memoryBytes: commandMemory,
      settings: ["executionWorkspaces.worker.concurrency", "infrastructure.sandbox.memoryBytes"]
    }
  ];
  if (modules.isEnabled("apps")) {
    terms.push({
      kind: "page builds",
      slots: positive(input.env.PAGE_BUILD_CONCURRENCY) ?? PAGE_BUILD_DEFAULT_SLOTS,
      memoryBytes: commandMemory,
      settings: ["PAGE_BUILD_CONCURRENCY", "infrastructure.sandbox.memoryBytes"]
    });
  }
  if (modules.isEnabled("workflows")) {
    terms.push({
      kind: "code steps",
      slots: config.workflows.codeSteps.slots,
      memoryBytes: config.workflows.codeSteps.memoryBytes,
      settings: ["workflows.codeSteps.slots", "workflows.codeSteps.memoryBytes"]
    });
  }
  return terms;
}

/** What the sandboxes of a config need when every slot is taken. */
export function sandboxMemoryNeeded(terms: readonly SandboxMemoryTerm[]): number {
  return terms.reduce((sum, term) => sum + term.slots * term.memoryBytes, 0);
}

/** The sentence of one term: its product and the two settings it is made of. */
function describe(term: SandboxMemoryTerm): string {
  return `${term.kind}: ${term.slots} x ${gib(term.memoryBytes)} = ${gib(term.slots * term.memoryBytes)} (${term.settings[0]} x ${term.settings[1]})`;
}

/**
 * Refuses a config whose sandboxes can need more memory at once than the host has, with the
 * reason `sandbox_memory_exceeds_host` and every term in the message. Where the sandbox is a
 * Docker engine on another host, this process cannot read that host's memory: it says so in
 * a warning and the worker starts.
 */
export function assertSandboxMemoryFitsHost(input: {
  config: ClientInstanceConfig;
  modules: Pick<ModuleSnapshot, "isEnabled">;
  env: Pick<ClientInstanceEnv, "PAGE_BUILD_CONCURRENCY">;
  logger: Pick<Logger, "warn">;
  /** The memory of the host as this process reads it. For a test, in place of the host's. */
  hostMemoryBytes?: number;
}): void {
  const terms = sandboxMemoryTerms(input);
  if (terms.length === 0) return;
  const needed = sandboxMemoryNeeded(terms);
  const sums = terms.map(describe).join("; ");
  if (typeof input.config.infrastructure.sandbox?.endpoint === "string") {
    input.logger.warn(
      {
        neededBytes: needed,
        terms: terms.map(({ kind, slots, memoryBytes }) => ({ kind, slots, memoryBytes }))
      },
      `The sandbox is a Docker engine on another host, whose memory this process cannot read: the sandboxes of this config can need ${gib(needed)} at once (${sums}). Make sure that host has it`
    );
    return;
  }
  const host = input.hostMemoryBytes ?? totalmem();
  if (needed <= host) return;
  throw new AppError(
    "VALIDATION_FAILED",
    `The sandboxes that can run at once need ${gib(needed)} of memory, and this host has ${gib(host)}: ${sums}. Lower one of the named settings, or run the command worker on a host with more memory`,
    {
      reason: "sandbox_memory_exceeds_host",
      neededBytes: needed,
      hostBytes: host,
      terms: terms.map(({ kind, slots, memoryBytes, settings }) => ({
        kind,
        slots,
        memoryBytes,
        settings: [...settings]
      }))
    }
  );
}
