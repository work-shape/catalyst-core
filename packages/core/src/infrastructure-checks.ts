import type { ClientInstanceId } from "./ids";
import type { ProviderCheckErrorClass } from "./providers";

/** What the last check of one provider found, as every process of the instance reads it. */
export type InfrastructureCheckOutcome =
  | { ok: true; checkedAt: string }
  | { ok: false; checkedAt: string; errorClass: ProviderCheckErrorClass };

export interface InfrastructureCheckState {
  /** The last outcome of each provider that was ever checked, by the provider's id. */
  outcomes: Record<string, InfrastructureCheckOutcome>;
  /** When a person last started a check of the whole instance. */
  manualCheckAt?: Date;
}

/**
 * The check results of an instance and the moment of its last manual check. Every API process
 * and the worker that owns a provider write here and every API process reads here, so a page
 * shows the same health whichever process answers.
 */
export interface InfrastructureCheckStore {
  read(input: { clientInstanceId: ClientInstanceId }): Promise<InfrastructureCheckState>;
  /** Writes these providers' outcomes and keeps those of every other provider. */
  recordOutcomes(input: {
    clientInstanceId: ClientInstanceId;
    outcomes: Record<string, InfrastructureCheckOutcome>;
  }): Promise<void>;
  /**
   * Claims the manual check for the caller in one statement: of the processes that ask inside
   * `minIntervalMs` of the last claim, none gets it, and of those that ask at the same moment
   * after it, one does. `manualCheckAt` is the claim that stands afterwards.
   */
  claimManualCheck(input: {
    clientInstanceId: ClientInstanceId;
    at: Date;
    minIntervalMs: number;
  }): Promise<{ claimed: boolean; manualCheckAt: Date }>;
}
