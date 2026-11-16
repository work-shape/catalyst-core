import { z } from "zod";
import { noReportedUsage } from "./openai-compatible-mapping";
import { ModelProviderError } from "./model-provider-error";
import type { ModelAdapterTranscription, ModelAdapterTranscriptionRequest } from "./types";

/**
 * The multipart body of `POST <baseUrl>/audio/transcriptions`. Each term is its own
 * `context_bias` field, as Mistral reads them; the audio is sent from memory.
 */
export function toOpenAiTranscriptionsRequestBody(
  request: ModelAdapterTranscriptionRequest
): FormData {
  const body = new FormData();
  body.append("model", request.model);
  body.append(
    "file",
    // A copy on its own buffer, which a Blob takes whatever buffer the bytes came in.
    new Blob([new Uint8Array(request.audio.bytes)], { type: request.audio.mimeType }),
    request.audio.filename
  );
  if (request.language) body.append("language", request.language);
  for (const term of request.terms) body.append("context_bias", term);
  return body;
}

/**
 * The usage of an answer. Mistral counts `prompt_audio_seconds` and tokens; OpenAI counts
 * `seconds` for a model billed by duration and `input_tokens`/`output_tokens` for one billed by
 * tokens; a `verbose_json` answer carries `duration` at the top.
 */
const transcriptionUsageSchema = z.object({
  prompt_audio_seconds: z.number().nonnegative().nullish(),
  seconds: z.number().nonnegative().nullish(),
  prompt_tokens: z.number().int().nonnegative().nullish(),
  completion_tokens: z.number().int().nonnegative().nullish(),
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  total_tokens: z.number().int().nonnegative().nullish()
});

const transcriptionResponseSchema = z.object({
  text: z.string(),
  duration: z.number().nonnegative().nullish(),
  usage: transcriptionUsageSchema.nullish()
});

/** The text of an answer and what the provider counted for it. Seconds are rounded up. */
export function readOpenAiTranscription(payload: unknown): ModelAdapterTranscription {
  const parsed = transcriptionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ModelProviderError({
      kind: "invalid_response",
      message: "Model provider returned no transcription"
    });
  }
  const { text, duration, usage } = parsed.data;
  const seconds = usage?.prompt_audio_seconds ?? usage?.seconds ?? duration ?? undefined;
  return {
    text: text.trim(),
    ...(seconds === undefined ? {} : { audioSeconds: Math.ceil(seconds) }),
    usage: usage ? toTranscriptionUsage(usage) : noReportedUsage()
  };
}

function toTranscriptionUsage(
  usage: z.output<typeof transcriptionUsageSchema>
): ModelAdapterTranscription["usage"] {
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    // Audio priced per minute needs the seconds alone; the tokens are what the provider said.
    source: "provider_reported"
  };
}
