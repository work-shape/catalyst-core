import { z } from "zod";
import { AppError, defineProvider, secretRef } from "@vivd-catalyst/core";
import {
  BEDROCK_CAPABILITIES,
  BEDROCK_REGION,
  BEDROCK_RUNTIME_HOST,
  BedrockProvider
} from "./bedrock-provider";
import type { ModelAdapterFactory } from "../types";

const bedrockConfigSchema = z.object({
  /** Names the secret that holds the Bedrock API key of this consumer. */
  credentialSecret: secretRef().default("AWS_BEARER_TOKEN_BEDROCK")
});

/**
 * Claude on Amazon Bedrock through `InvokeModel` in the Anthropic Messages format. The endpoint
 * is Bedrock Runtime in Frankfurt and no setting names another; the entry's `region` must be
 * `eu`. A model is the consumer's application inference profile, by its ARN.
 */
export const bedrockModelProvider = defineProvider({
  port: "models",
  type: "aws-bedrock",
  configSchema: bedrockConfigSchema,
  external: true,
  async create(config, { secrets, entryPath }): Promise<ModelAdapterFactory> {
    const bearerToken = await secrets.resolve(config.credentialSecret);
    const build: ModelAdapterFactory = (entry) => {
      if (entry.region !== "eu") {
        throw new AppError(
          "VALIDATION_FAILED",
          `'${entryPath}.region' must be 'eu': the 'aws-bedrock' provider calls Bedrock in ${BEDROCK_REGION} and nowhere else`
        );
      }
      const provider = new BedrockProvider({ id: entry.id, bearerToken });
      provider.assertModel(entry.model);
      return {
        // Asked at startup for every binding, so a binding with a model id that is not a
        // profile stops startup like the entry's own.
        capabilities: (model) => {
          provider.assertModel(model);
          return BEDROCK_CAPABILITIES;
        },
        complete: (request) => provider.complete(request),
        stream: (request) => provider.stream(request)
      };
    };
    build.check = (context) => new BedrockProvider({ id: entryPath, bearerToken }).check(context);
    return build;
  },
  async check(build, context) {
    return (await build.check?.(context)) ?? { ok: true };
  },
  describe() {
    return { endpointHost: BEDROCK_RUNTIME_HOST };
  }
});
