import { z } from "zod";
import { AppError, defineProvider, secretRef } from "@vivd-catalyst/core";
import { createGoogleAccessTokenSource } from "./google-vertex-auth";
import { GOOGLE_VERTEX_CAPABILITIES, GoogleVertexProvider } from "./google-vertex-provider";
import type { ModelAdapterFactory } from "../types";

const googleVertexConfigSchema = z.object({
  /** The Google Cloud project the calls are billed to. */
  projectId: z.string().min(1),
  /** Names the secret that holds the JSON key of the service account. */
  credentialSecret: secretRef().default("GOOGLE_VERTEX_CREDENTIALS")
});

/**
 * Gemini on Vertex AI through `generateContent`. The entry's `region` decides the Vertex
 * location and host: `eu` stays on Google's European endpoint.
 */
export const googleVertexModelProvider = defineProvider({
  port: "models",
  type: "google-vertex",
  configSchema: googleVertexConfigSchema,
  external: true,
  async create(config, { secrets, entryPath }): Promise<ModelAdapterFactory> {
    const tokens = createGoogleAccessTokenSource(
      await secrets.resolve(config.credentialSecret),
      config.credentialSecret
    );
    const build: ModelAdapterFactory = (entry) => {
      if (!entry.region) {
        throw new AppError("VALIDATION_FAILED", `'${entryPath}.region' is required`);
      }
      const provider = new GoogleVertexProvider({
        id: entry.id,
        projectId: config.projectId,
        region: entry.region,
        tokens
      });
      return {
        capabilities: () => GOOGLE_VERTEX_CAPABILITIES,
        complete: (request) => provider.complete(request),
        stream: (request) => provider.stream(request)
      };
    };
    build.check = (context) => tokens.check(context);
    return build;
  },
  async check(build, context) {
    return (await build.check?.(context)) ?? { ok: true };
  },
  describe(config) {
    return { projectId: config.projectId };
  }
});
