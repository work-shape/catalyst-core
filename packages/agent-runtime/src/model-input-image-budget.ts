import {
  modelContentImages,
  type ModelContentPart,
  type ModelMessage
} from "@vivd-catalyst/model-provider";
import { omitModelVisibleImages } from "./model-visible-artifacts";

type ModelImagePart = Extract<ModelContentPart, { type: "image" }>;

// The most image bytes one model request carries. It keeps a request body bounded: measured on
// production on 2026-10-09, one run loaded 96 MB of page images and resent them on every step.
// The newest images stay; where an older one was, a line names what it showed, and the model
// repeats the tool call to see it again.
// It does not keep a provider compaction item under the provider's string limit of 20,971,520
// characters: such an item measured 2.2 times (at worst 2.5 times) the image bytes it covers, so
// the guarantee asks for less than 8 MiB, about 6 MiB with a margin. Measured on 2026-10-10, a
// page in the model's rendition (MODEL_PAGE_IMAGE_MAX_LONG_EDGE_PIXELS) weighs 0.27 to 0.45 MB,
// so a run that views 15 pages carries about 5.6 MB: it would fit 6 MiB once, not several times,
// and the model would lose pages it is still reading. The budget therefore stays where 15 pages
// fit six times, and a run above about 22 viewed pages can still pass the provider's limit.
export const MODEL_INPUT_IMAGES_MAX_BYTES = 32 * 1024 * 1024;

export interface ModelInputImageBudgetResult {
  messages: ModelMessage[];
  /** How many images were left out of the request. */
  omittedImageCount: number;
}

/**
 * Keeps the images of a request within the budget, counted image by image, and names the ones
 * left out where they were. The images of the newest user message go first, because no tool can
 * load an image the user attached again; then every other image, newest first.
 */
export function applyModelInputImageBudget(
  messages: ModelMessage[],
  maxBytes: number = MODEL_INPUT_IMAGES_MAX_BYTES
): ModelInputImageBudgetResult {
  const newestUserIndex = messages.findLastIndex((message) => message.role === "user");
  const newestFirst = messages
    .flatMap((message, index) =>
      modelContentImages(message.content).map((image) => ({ index, image }))
    )
    .reverse();
  const byPriority = [
    ...newestFirst.filter((entry) => entry.index === newestUserIndex).reverse(),
    ...newestFirst.filter((entry) => entry.index !== newestUserIndex)
  ];
  let remainingBytes = maxBytes;
  let exhausted = false;
  const omitted = new Set<ModelImagePart>();
  for (const { image } of byPriority) {
    // Once one image does not fit, every image after it is left out too, so the newest stay.
    exhausted ||= image.data.byteLength > remainingBytes;
    if (exhausted) {
      omitted.add(image);
    } else {
      remainingBytes -= image.data.byteLength;
    }
  }
  if (omitted.size === 0) {
    return { messages, omittedImageCount: 0 };
  }
  return {
    messages: messages.map((message) => ({
      ...message,
      content: omitModelVisibleImages(message.content, omitted)
    })),
    omittedImageCount: omitted.size
  };
}
