import type {
  Infrastructure,
  InfrastructureCheck,
  InfrastructureClass,
  InfrastructureOrigin,
  InfrastructureProvider,
  InfrastructureSecret
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  isSecretName,
  type ClientInstanceId,
  type InfrastructureCheckOutcome,
  type InfrastructureCheckStore,
  type Logger,
  type ProviderCheckResult,
  type ProviderRegion,
  type SecretResolver
} from "@vivd-catalyst/core";
import { INFRASTRUCTURE_CHECK_INTERVAL_MS } from "./job-kinds";

/**
 * Protects the providers from a person who keeps pressing "Check now". Inside it the operation
 * is refused with 429 `RATE_LIMITED` and the seconds to wait, whoever asked first; the answer
 * of the read says from when it runs again. The instance's own five-minute check is not
 * counted.
 */
export const INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS = 60_000;

/**
 * One thing the instance runs on, as the assembly hands it over: what may be shown of its
 * config, the names of its secrets, and how to ask it. It holds no secret value.
 */
export interface InfrastructureEntry {
  /** Where the entry sits in the release config, such as `models.azure-eu` or `mail`. */
  id: string;
  class: InfrastructureClass;
  name?: string;
  type: string;
  origin: InfrastructureOrigin;
  external: boolean;
  region?: ProviderRegion;
  endpointHost?: string;
  bucket?: string;
  /** The fields named in `InfrastructureProvider.withheld`. */
  withheld?: readonly ("endpointHost" | "bucket")[];
  /**
   * The secrets it takes: the name the config gives and the key of the config that gives it.
   * A name the platform fixes itself, such as `DATABASE_URL`, has no key.
   */
  secrets: readonly { name: string; field?: string }[];
  /**
   * Asks the provider. It must end by itself and never throw, which a provider definition's
   * `check` does. Absent when another process holds the provider: that process checks it and
   * writes the outcome under this entry's id.
   */
  check?: () => Promise<ProviderCheckResult>;
}

/**
 * Instance > Infrastructure: what the instance runs on and whether each provider answers. The
 * results and the moment of the last manual check are kept in the database, one row for the
 * instance, so every API process shows the same and "Check now" runs once a minute for all of
 * them. A read answers from that row and calls no provider; only the schedule and "Check now"
 * do.
 */
export class InfrastructureWorkflow {
  private running: Promise<void> | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      entries: readonly InfrastructureEntry[];
      /**
       * Every secret name the release config declares. A reference of an entry that is not
       * among them is not looked up and not listed.
       */
      declaredSecretNames: ReadonlySet<string>;
      secrets: SecretResolver;
      store: InfrastructureCheckStore;
      clientInstanceId: ClientInstanceId;
      logger: Logger;
      now?: () => Date;
    }
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(): Promise<Infrastructure> {
    const { clientInstanceId } = this.options;
    const state = await this.options.store.read({ clientInstanceId });
    const availableAt =
      state.manualCheckAt === undefined
        ? undefined
        : state.manualCheckAt.getTime() + INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS;
    return {
      items: await Promise.all(
        this.options.entries.map((entry) => this.listed(entry, state.outcomes[entry.id]))
      ),
      checkIntervalSeconds: INFRASTRUCTURE_CHECK_INTERVAL_MS / 1000,
      ...(availableAt !== undefined && availableAt > this.now().getTime()
        ? { checkAvailableAt: new Date(availableAt).toISOString() }
        : {})
    };
  }

  /** "Check now": one run for the instance per minute, then the results. */
  async checkNow(): Promise<Infrastructure> {
    const at = this.now();
    // The database decides: of the API processes asked inside one minute, one runs the check.
    const claim = await this.options.store.claimManualCheck({
      clientInstanceId: this.options.clientInstanceId,
      at,
      minIntervalMs: INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS
    });
    if (!claim.claimed) {
      const waitMs =
        claim.manualCheckAt.getTime() + INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS - at.getTime();
      throw new AppError("RATE_LIMITED", "The providers were checked less than a minute ago", {
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000))
      });
    }
    await this.runChecks();
    return this.get();
  }

  /**
   * Asks every provider this process holds once, all at the same time, and writes what it
   * found. A caller that arrives while a run is under way waits for that run instead of
   * starting another, so this process never asks a provider twice at once.
   */
  runChecks(): Promise<void> {
    this.running ??= this.checkAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkAll(): Promise<void> {
    const { clientInstanceId, store } = this.options;
    const outcomes: Record<string, InfrastructureCheckOutcome> = {};
    await Promise.all(
      this.options.entries.map(async (entry) => {
        if (!entry.check) {
          return;
        }
        let result: ProviderCheckResult;
        try {
          result = await entry.check();
        } catch {
          result = { ok: false, errorClass: "failed" };
        }
        const checkedAt = this.now().toISOString();
        outcomes[entry.id] = result.ok
          ? { ok: true, checkedAt }
          : { ok: false, checkedAt, errorClass: result.errorClass };
      })
    );
    const before = (await store.read({ clientInstanceId })).outcomes;
    await store.recordOutcomes({ clientInstanceId, outcomes });
    for (const entry of this.options.entries) {
      const outcome = outcomes[entry.id];
      if (outcome) {
        logProviderCheckChange(this.options.logger, entry, before[entry.id], outcome);
      }
    }
  }

  private async listed(
    entry: InfrastructureEntry,
    outcome: InfrastructureCheckOutcome | undefined
  ): Promise<InfrastructureProvider> {
    return {
      id: entry.id,
      class: entry.class,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      type: entry.type,
      origin: entry.origin,
      external: entry.external,
      ...(entry.region === undefined ? {} : { region: entry.region }),
      ...(entry.endpointHost === undefined ? {} : { endpointHost: entry.endpointHost }),
      ...(entry.bucket === undefined ? {} : { bucket: entry.bucket }),
      ...(entry.withheld?.length ? { withheld: [...entry.withheld] } : {}),
      secrets: (await Promise.all(entry.secrets.map((secret) => this.listedSecret(secret)))).flat(),
      check: checkOf(entry, outcome)
    };
  }

  /**
   * A reference is listed when the release config declares it. Its name is shown while it
   * resolves, which is what makes it the name of a secret; one that resolves to nothing is told
   * by the key of the config, because what stands there may be the secret itself.
   */
  private async listedSecret(secret: {
    name: string;
    field?: string;
  }): Promise<InfrastructureSecret[]> {
    if (!this.options.declaredSecretNames.has(secret.name) || !isSecretName(secret.name)) {
      return [];
    }
    const state = await this.secretState(secret.name);
    return [
      state === "set" || secret.field === undefined
        ? { name: secret.name, state }
        : { field: secret.field, state }
    ];
  }

  /** Whether a secret resolves. The value is dropped here and goes nowhere. */
  private async secretState(name: string): Promise<"set" | "missing"> {
    try {
      await this.options.secrets.resolve(name);
      return "set";
    } catch {
      return "missing";
    }
  }
}

function checkOf(
  entry: InfrastructureEntry,
  outcome: InfrastructureCheckOutcome | undefined
): InfrastructureCheck {
  if (!outcome) {
    // A provider another process holds has an outcome once that process published one.
    return { status: entry.check ? "pending" : "not_checked" };
  }
  return outcome.ok
    ? { status: "ok", checkedAt: outcome.checkedAt }
    : { status: "failed", checkedAt: outcome.checkedAt, errorClass: outcome.errorClass };
}

/**
 * Logs a provider that stopped answering, fails in another way than before, or answers again.
 * The line holds the provider's place in the config, its type and the class: nothing else.
 */
export function logProviderCheckChange(
  logger: Logger,
  provider: { id: string; type: string },
  before: InfrastructureCheckOutcome | undefined,
  outcome: InfrastructureCheckOutcome
): void {
  if (!outcome.ok && (before?.ok !== false || before.errorClass !== outcome.errorClass)) {
    logger.warn(
      { provider: provider.id, type: provider.type, errorClass: outcome.errorClass },
      "A provider does not answer its check"
    );
  } else if (outcome.ok && before?.ok === false) {
    logger.info(
      { provider: provider.id, type: provider.type },
      "A provider answers its check again"
    );
  }
}
