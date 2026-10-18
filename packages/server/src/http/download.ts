import { z } from "zod";

/** A live file answer. The iterator is consumed by HTTP and never retained as run data. */
export interface DownloadAnswer {
  filename: string;
  contentType: string;
  body: AsyncIterable<string>;
}
export const downloadAnswerSchema = z.custom<DownloadAnswer>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "contentType" in value &&
    typeof value.contentType === "string" &&
    "body" in value &&
    typeof value.body === "object" &&
    value.body !== null &&
    Symbol.asyncIterator in value.body
);
