import type { PlatformEventDefinition } from "./definition";

export const transcriptionEvents = {
  // A recording from the composer was turned into text (STT-1). The binding and the seconds of
  // audio only: never the audio, the text or the terms sent with it.
  "transcription.completed": {
    name: "transcription.completed",
    subject: "model_binding",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["bindingId", "durationSeconds"],
      properties: {
        bindingId: { type: "string" },
        durationSeconds: { type: "number", minimum: 0 }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
