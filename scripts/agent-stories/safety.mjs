import { createHash } from "node:crypto";

// These are approved trial ceilings, not product safeguard overrides.
export const LIMITS = {
  tokens: 2_000_000,
  micros: 10_000_000,
  totalMs: 60 * 60_000,
  startupMs: 20 * 60_000
};
export const hash = (value) => createHash("sha256").update(value).digest("hex");

// The committed pin includes explanatory comments, never part of the Docker image name.
export function parsePinnedImage(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length !== 1 || !/^[^\s]+@sha256:[a-f0-9]{64}$/u.test(lines[0]))
    throw new Error("Postgres pin must name one image by digest");
  return lines[0];
}

// Only this schema reaches evidence. Never retain headers, config/env, SSE or errors from providers.
const KEYS = new Set(
  "id kind name status mode target operation revision expectedRevision tester expectedTester total notify deliveries published liveRuns invalidRows validRows reloadedRows freshRows otherRows storageCommitted errors beforeAssets beforeRevisions beforeFiles reconnectAssets reconnectRevisions reconnectFiles deniedAssets deniedRevisions deniedFiles pendingStatus deniedStatus allowedAssets allowedRevisions allowedExecutions replayRevisions replayExecutions instructionMatches ownerMatches actorId conversationId runId createdAt story scenario assertions code message prompt path hash provider model reasoningEffort bindingId tokens settledTokens reservedTokens micros settledMicros reservedMicros pending calls source currency overshootTokens overshootMicros startedAt endedAt elapsedMs cleanup uid host root head dirty builds config migrations modules workers entrypoint ports image imageId pid label owner worktree baseline usage counters costMicros periodKind periodStart scopeKind scopeId seededIds seed steps created existing coverage cases manual stories results verdict exitCode prerequisites differences runLine time budget peak missingCosts observations capabilities deadlineMs totalMs startupMs micros tokenLimit spendLimit usageEvents runs jobs operations approvals purpose".split(
    " "
  )
);
export function evidence(value, secrets = []) {
  if (typeof value === "string") {
    let clean = value;
    for (const secret of secrets.filter(Boolean)) clean = clean.replaceAll(secret, "[redacted]");
    return clean.replace(/(?:Bearer\s+\S+|\bsk-[\w-]+)/gu, "[redacted]");
  }
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((v) => evidence(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => KEYS.has(k))
        .map(([k, v]) => [k, evidence(v, secrets)])
    );
  return null;
}
// Start from all-call rows, including titles/workers. Pending/abandoned calls retain reservations.
export function usageTotal(rows) {
  return rows.reduce(
    (sum, row) => {
      const unsettled = row.status === "pending" || row.status === "abandoned";
      const settled = row.customer_billable_cost?.status === "settled";
      sum.calls++;
      sum.pending += Number(unsettled);
      sum.settledTokens += unsettled ? 0 : Number(row.total_tokens);
      sum.reservedTokens += unsettled ? Number(row.counted_tokens ?? 0) : 0;
      sum.settledMicros += unsettled ? 0 : Number(row.customer_billable_cost?.totalCostMicros ?? 0);
      sum.reservedMicros += unsettled ? Number(row.counted_cost_micros ?? 0) : 0;
      sum.missingCosts ||= unsettled
        ? row.counted_cost_micros == null || row.counted_tokens == null
        : !settled;
      sum.tokens = sum.settledTokens + sum.reservedTokens;
      sum.micros = sum.settledMicros + sum.reservedMicros;
      return sum;
    },
    {
      calls: 0,
      pending: 0,
      settledTokens: 0,
      reservedTokens: 0,
      settledMicros: 0,
      reservedMicros: 0,
      tokens: 0,
      micros: 0,
      missingCosts: false
    }
  );
}
export function budgetStop(usage, now, deadline, inheritedMicros = 0, limits = LIMITS) {
  if (usage.missingCosts) return "missing_cost";
  if (now >= deadline) return "deadline";
  if (usage.tokens >= limits.tokens) return "tokens";
  if (usage.micros + inheritedMicros >= limits.micros) return "spend";
  return undefined;
}
export function validateReceipt(actual, expected) {
  for (const key of [
    "owner",
    "uid",
    "host",
    "root",
    "head",
    "dirty",
    "builds",
    "capabilities",
    "config",
    "migrations",
    "modules",
    "workers",
    "entrypoint",
    "image",
    "imageId",
    "ports"
  ]) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      throw new Error(`Refusing stale/shared stack: ${key}`);
  }
  if (actual.status !== "idle") throw new Error("Refusing busy stack");
  if (actual.pending || actual.activeJobs || actual.activeRuns)
    throw new Error("Refusing active model work");
}
