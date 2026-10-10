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
   * `check` does. Absent when another process holds the provider.
   */
  check?: () => Promise<ProviderCheckResult>;
}

interface CheckOutcome {
  checkedAt: Date;
  result: ProviderCheckResult;
}

/**
 * Instance > Infrastructure: what the instance runs on and whether each provider answers. The
 * results of the last run are kept in this process and nowhere else. A read answers from them
 * and calls no provider; only the schedule and "Check now" do.
 */
export class InfrastructureWorkflow {
  private readonly outcomes = new Map<string, CheckOutcome>();
  private running: Promise<void> | undefined;
  private checkedNowAt: number | undefined;
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
      logger: Logger;
      now?: () => Date;
    }
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(): Promise<Infrastructure> {
    const availableAt =
      this.checkedNowAt === undefined
        ? undefined
        : this.checkedNowAt + INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS;
    return {
      items: await Promise.all(this.options.entries.map((entry) => this.listed(entry))),
      checkIntervalSeconds: INFRASTRUCTURE_CHECK_INTERVAL_MS / 1000,
      ...(availableAt !== undefined && availableAt > this.now().getTime()
        ? { checkAvailableAt: new Date(availableAt).toISOString() }
        : {})
    };
  }

  /** "Check now": one run for the instance per minute, then the results. */
  async checkNow(): Promise<Infrastructure> {
    const now = this.now().getTime();
    const waitMs =
      this.checkedNowAt === undefined
        ? 0
        : this.checkedNowAt + INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS - now;
    if (waitMs > 0) {
      throw new AppError("RATE_LIMITED", "The providers were checked less than a minute ago", {
        retryAfterSeconds: Math.ceil(waitMs / 1000)
      });
    }
    this.checkedNowAt = now;
    await this.runChecks();
    return this.get();
  }

  /**
   * Asks every provider once, all at the same time. A caller that arrives while a run is under
   * way waits for that run instead of starting another, so a provider is never asked twice at
   * once.
   */
  runChecks(): Promise<void> {
    this.running ??= this.checkAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkAll(): Promise<void> {
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
        this.record(entry, { checkedAt: this.now(), result });
      })
    );
  }

  /** Keeps the outcome and logs a provider that stopped answering or answers again. */
  private record(entry: InfrastructureEntry, outcome: CheckOutcome): void {
    const before = this.outcomes.get(entry.id)?.result;
    this.outcomes.set(entry.id, outcome);
    const { result } = outcome;
    if (!result.ok && (before?.ok !== false || before.errorClass !== result.errorClass)) {
      this.options.logger.warn(
        { provider: entry.id, type: entry.type, errorClass: result.errorClass },
        "A provider does not answer its check"
      );
    } else if (result.ok && before?.ok === false) {
      this.options.logger.info(
        { provider: entry.id, type: entry.type },
        "A provider answers its check again"
      );
    }
  }

  private async listed(entry: InfrastructureEntry): Promise<InfrastructureProvider> {
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
      check: this.checkOf(entry)
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

  private checkOf(entry: InfrastructureEntry): InfrastructureCheck {
    if (!entry.check) {
      return { status: "not_checked" };
    }
    const outcome = this.outcomes.get(entry.id);
    if (!outcome) {
      return { status: "pending" };
    }
    const checkedAt = outcome.checkedAt.toISOString();
    return outcome.result.ok
      ? { status: "ok", checkedAt }
      : { status: "failed", checkedAt, errorClass: outcome.result.errorClass };
  }
}
