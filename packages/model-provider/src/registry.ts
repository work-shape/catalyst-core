import { AppError, type RuntimeCallContext } from "@vivd-stage/core";
import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelCompletionStreamEvent,
  ModelProvider
} from "./types";

export class ModelProviderRegistry implements ModelProvider {
  readonly id = "registry";
  private readonly providers = new Map<string, ModelProvider>();

  constructor(providers: ModelProvider[]) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }
  }

  async complete(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): Promise<ModelCompletion> {
    const provider = this.getProvider(request.providerId);
    return provider.complete(request, context);
  }

  async *stream(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    const provider = this.getProvider(request.providerId);
    if (!provider.stream) {
      yield {
        type: "completed",
        completion: await provider.complete(request, context)
      };
      return;
    }

    yield* provider.stream(request, context);
  }

  private getProvider(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not registered`);
    }
    return provider;
  }
}
