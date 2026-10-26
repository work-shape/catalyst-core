import {
  MODEL_FALLBACK_REASONS,
  type ModelFallbackReason
} from "@work-shape/catalyst-asset-schemas";

export { MODEL_FALLBACK_REASONS, type ModelFallbackReason };

export function isModelFallbackReason(value: unknown): value is ModelFallbackReason {
  return MODEL_FALLBACK_REASONS.some((reason) => reason === value);
}

/** A model binding as the line under an answer names it. */
export interface StoredModelFallbackBinding {
  bindingId: string;
  /** The model id the binding asks for: what the line shows, tidied, where it has no label. */
  model: string;
  /** The name release config gives the model. */
  label?: string;
}

/** The run that wrote the answer switched from `from` to its fallback `to`, which answered. */
export interface StoredModelFallback {
  from: StoredModelFallbackBinding;
  to: StoredModelFallbackBinding;
  reason: ModelFallbackReason;
}
