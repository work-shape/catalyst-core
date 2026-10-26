import { describe, expect, it } from "vitest";
import { isJsonObject, isRecord, type JsonValue } from "@work-shape/catalyst-core";

describe("record guards", () => {
  it("accepts any non-null object except arrays, without checking its values or prototype", () => {
    const objects: unknown[] = [
      {},
      { value: undefined, callback: () => undefined },
      Object.create(null),
      new Date(0),
      new Error("example")
    ];
    const others: unknown[] = [
      null,
      undefined,
      [],
      [{}],
      "",
      "value",
      0,
      1,
      false,
      true,
      Symbol(),
      1n,
      () => ({})
    ];

    for (const value of objects) expect(isRecord(value)).toBe(true);
    for (const value of others) expect(isRecord(value)).toBe(false);
  });

  it("keeps the JSON guard's object semantics for JSON values", () => {
    const objects: JsonValue[] = [{}, { nested: [null, { value: true }] }];
    const others: (JsonValue | undefined)[] = [
      null,
      undefined,
      [],
      [{}],
      "",
      "value",
      0,
      1,
      false,
      true
    ];

    for (const value of objects) expect(isJsonObject(value)).toBe(true);
    for (const value of others) expect(isJsonObject(value)).toBe(false);
  });
});
