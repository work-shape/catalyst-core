import type { JsonValue } from "./json";

/** A named store fetches at most limit rows after a stable, exclusive key tuple. */
export interface StorePage {
  limit: number;
  after?: readonly (string | number)[];
}

/** Base64url of UTF-8 JSON, preserving the payload's property and tuple order. */
export function encodePageCursor(payload: JsonValue): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode the wire payload; each list validates its shape and supplies its own cursor error. */
export function decodePageCursor(cursor: string): unknown {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}
