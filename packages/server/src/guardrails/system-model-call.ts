import type { ReasoningEffortConfig } from "@work-shape/catalyst-core";
import type { ResolvedModelSelection } from "@work-shape/catalyst-config-schema";
import type { ModelBindingRef, ModelGateway } from "@work-shape/catalyst-model-provider";

/**
 * The gateway as the server's own model calls use it: conversation titles, approval checks and,
 * where the instance turns speech into text (STT-1), the composer's transcriptions. A server
 * without `transcribe` answers that speech to text is not available.
 */
export type SystemModelGateway = Pick<ModelGateway, "complete" | "capabilities"> &
  Partial<Pick<ModelGateway, "transcribe">>;

/** How a call names the model a config selection resolved to. */
export function modelBindingRefOf(selection: ResolvedModelSelection): ModelBindingRef {
  return selection.binding
    ? { bindingId: selection.binding.id }
    : { providerId: selection.provider.id, model: selection.model };
}

/**
 * The configured effort, when the model takes it. A model that takes none is called without
 * one, as an agent run calls it; the gateway refuses an effort the model does not declare.
 */
export function reasoningEffortTheModelTakes(
  gateway: Pick<ModelGateway, "capabilities">,
  binding: ModelBindingRef,
  configured: ReasoningEffortConfig | undefined
): ReasoningEffortConfig | undefined {
  return configured !== undefined &&
    gateway.capabilities(binding).reasoningEfforts.includes(configured)
    ? configured
    : undefined;
}
