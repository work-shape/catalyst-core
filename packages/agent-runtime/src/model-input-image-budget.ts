import type { ModelMessage } from "@vivd-catalyst/model-provider";
import { withoutModelVisibleImages } from "./model-visible-artifacts";

// The most image bytes one model request carries. It keeps a request body bounded: measured on
// production on 2026-10-09, one run loaded 96 MB of page images and resent them on every step.
// The newest messages keep their images; in older ones a line names what each image showed, and
// the model repeats the tool call to see one again. Of 198 runs that viewed pages in 30 days,
// half loaded under 6 MB, nine in ten under 18 MB, and 3 loaded more than this.
// It does not keep a provider compaction item under the provider's string limit of 20,971,520
// characters: such an item measured 2.2 times (at worst 2.5 times) the image bytes it covers,
// which asks for 8 MiB, and 72 of those 198 runs loaded more than that.
export const MODEL_INPUT_IMAGES_MAX_BYTES = 32 * 1024 * 1024;

export interface ModelInputImageBudgetResult {
  messages: ModelMessage[];
  /** How many images were left out of the request. */
  omittedImageCount: number;
}

/** Keeps the newest images of a request within the budget and marks where older ones were. */
export function applyModelInputImageBudget(
  messages: ModelMessage[],
  maxBytes: number = MODEL_INPUT_IMAGES_MAX_BYTES
): ModelInputImageBudgetResult {
  let remainingBytes = maxBytes;
  let exhausted = false;
  let omittedImageCount = 0;
  const bounded = [...messages];
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const message = bounded[index];
    if (!message || typeof message.content === "string") {
      continue;
    }
    const images = message.content.filter((part) => part.type === "image");
    if (images.length === 0) {
      continue;
    }
    const bytes = images.reduce((total, image) => total + image.data.byteLength, 0);
    // Once one message does not fit, every older one is left out too, so the newest stay.
    exhausted ||= bytes > remainingBytes;
    if (!exhausted) {
      remainingBytes -= bytes;
      continue;
    }
    omittedImageCount += images.length;
    bounded[index] = { ...message, content: withoutModelVisibleImages(message.content) };
  }
  return { messages: omittedImageCount > 0 ? bounded : messages, omittedImageCount };
}
