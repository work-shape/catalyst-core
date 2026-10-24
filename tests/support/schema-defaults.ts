import { expect } from "vitest";
import { z } from "zod";

/** Check omitted and empty config branches, including those below required/optional parents. */
export function assertIndependentSchemaDefaults(schemas: Record<string, unknown>): void {
  const visited = new Set<object>();
  let checked = 0;

  function objects(
    value: unknown,
    path: string,
    visit: (value: object, path: string) => void
  ): void {
    if (typeof value !== "object" || value === null) return;
    visit(value, path);
    for (const [key, child] of Object.entries(value)) objects(child, `${path}.${key}`, visit);
  }

  function walk(value: unknown, path: string): void {
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    if (value instanceof z.ZodType) {
      if (["default", "prefault", "catch"].includes(value._zod.def.type)) {
        for (const omitted of [true, false]) {
          const first = value.safeParse(omitted ? undefined : {});
          if (!first.success) continue;
          const second = value.safeParse(omitted ? undefined : {});
          expect(second.success, path).toBe(true);
          if (!second.success) continue;
          expect(second.data, path).toEqual(first.data);
          const references = new Set<object>();
          objects(first.data, path, (object) => references.add(object));
          objects(second.data, path, (object, objectPath) => {
            expect(
              references.has(object),
              `Shared default at ${objectPath} for ${omitted ? "undefined" : "{}"}`
            ).toBe(false);
          });
          checked += 1;
        }
      }
      // Walk Zod definitions so required parents and omitted optional objects cannot hide defaults.
      walk(value._zod.def, path);
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (key !== "checks") walk(child, `${path}.${key}`);
      }
    }
  }

  walk(schemas, "config");
  expect(checked).toBeGreaterThan(0);
}
