import { createHmac, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  derivePersonalInputHashKey,
  hashInput,
  requirePersonalInputHashKey
} from "../packages/tool-execution/src/input-hash";

describe("personal operation input HMAC", () => {
  it("uses HMAC-SHA-256 with a stable purpose- and instance-bound derived key", () => {
    const key = derivePersonalInputHashKey("instance-store-key", "instance-a");
    expect(key).toEqual(derivePersonalInputHashKey("instance-store-key", "instance-a"));
    const hash = hashInput({ b: 2, a: "private" }, key);
    expect(hash).toBe(createHmac("sha256", key).update('{"a":"private","b":2}').digest("hex"));
    expect(hash).toBe(hashInput({ a: "private", b: 2 }, key));
    expect(hash).not.toBe(hashInput({ a: "private", b: 2 }));
    expect(hash).not.toBe(
      hashInput(
        { a: "private", b: 2 },
        derivePersonalInputHashKey("instance-store-key", "instance-b")
      )
    );
    expect(hash).not.toBe(
      hashInput({ a: "private", b: 2 }, derivePersonalInputHashKey("other-secret", "instance-a"))
    );
    expect(hashInput({ a: "private", b: 2 })).toBe(
      createHash("sha256").update('{"a":"private","b":2}').digest("hex")
    );
  });
  it("refuses a missing key instead of persisting a plain hash", () => {
    expect(() => requirePersonalInputHashKey(undefined)).toThrow(
      "Personal operation input hash key is unavailable"
    );
    expect(() => requirePersonalInputHashKey(new Uint8Array())).toThrow();
  });
});
