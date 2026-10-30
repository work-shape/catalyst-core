import type { GUARDRAIL_OUTCOMES } from "@work-shape/catalyst-asset-schemas";
import type { AssetScope } from "./asset-kinds";

/**
 * Where a guardrail comes from. `release`: the operator's floor, from release config, written
 * by the release seed and read-only in the product. `asset`: written as an asset and made live
 * by a publish; it adds checks to the floor and never removes one.
 */
export const GUARDRAIL_ORIGINS = ["release", "asset"] as const;
export type GuardrailOrigin = (typeof GUARDRAIL_ORIGINS)[number];

/**
 * What a person is shown of one guardrail's answer where they act (GR-3): which guardrail, its
 * outcome and reason, and where it belongs. Who can change it is read when it is shown, from
 * Rules in force, so it is never stored with the answer. Never the checked content.
 */
export interface GuardrailAnswerRef {
  name: string;
  title: string;
  outcome: (typeof GUARDRAIL_OUTCOMES)[number];
  /** The reason in plain language, where it gave one. */
  reason?: string;
  origin: GuardrailOrigin | "shipped";
  /** The guardrail's owner, for an `asset` answer. */
  scope?: AssetScope;
  /** The published revision that answered, for an `asset` answer. */
  revision?: number;
  /** A `require_approval` answered as a block, because the action could not wait. */
  approvalCannotWait?: true;
}
