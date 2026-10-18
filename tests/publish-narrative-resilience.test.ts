import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonObject, OperationDefinition } from "@work-shape/catalyst-core";
import {
  everything,
  narrator,
  operationDefinition,
  workspaceScope
} from "./support/publish-narrative";

const operation = "connection.outlook.send_mail";
const config = (count: number): JsonObject => ({
  manifest: {
    name: "Checks",
    steps: [
      { id: "start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...Array.from({ length: count }, (_, index) => ({
        id: `step-${index}`,
        name: `Check ${index}`,
        type: "operation",
        operation,
        input: {}
      }))
    ]
  }
});

function narrate(definition: OperationDefinition, count = 1, locale: "en" | "de" = "en") {
  return narrator({ definitions: [definition] }).narrate({
    kind: "workflow",
    name: "checks",
    scope: workspaceScope,
    revision: 1,
    config: config(count),
    locale,
    access: everything
  });
}

afterEach(() => vi.useRealTimers());

describe("publish narration survives outside input checks", () => {
  it.each(["en", "de"] as const)(
    "names a step that may stop when its check throws, in %s",
    async (locale) => {
      const result = await narrate(
        {
          ...operationDefinition(operation),
          inputSchema: z.unknown().superRefine(async () => {
            throw new Error("schema_check_timeout");
          })
        },
        1,
        locale
      );
      expect(result?.summary).toContain("Checks");
      expect(result?.warnings).toHaveLength(1);
      expect(result?.warnings[0]).toContain("Check 0");
      expect(result?.warnings[0]).toContain(
        locale === "en" ? "may stop" : "kann angehalten werden"
      );
      expect(JSON.stringify(result)).not.toContain("schema_check_timeout");
      expect(Object.keys(result ?? {}).sort()).toEqual(["summary", "warnings"]);
    }
  );

  it("warns that an input the Connection schema refuses may stop the step", async () => {
    const result = await narrate({
      ...operationDefinition(operation),
      inputSchema: z.object({ required: z.string() })
    });
    expect(result?.warnings[0]).toContain("may stop");
  });

  it("bounds the whole narration when its metadata read never answers", async () => {
    vi.useFakeTimers();
    const instance = narrator({
      stored: { appRevision: () => new Promise(() => {}), storeReaders: async () => [] }
    });
    const pending = instance.narrate({
      kind: "app",
      name: "checks",
      scope: workspaceScope,
      revision: 1,
      config: { title: "Checks", manifest: { actions: [] } },
      locale: "en",
      access: everything
    });
    const failed = expect(pending).rejects.toThrow("Publish narration timed out");
    await vi.advanceTimersByTimeAsync(3_100);
    await failed;
  });

  it.each([1, 50])(
    "returns all %i slow steps within one narration budget, including checks still queued",
    async (count) => {
      vi.useFakeTimers();
      const checked = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      });
      let settled = false;
      const started = Date.now();
      let finishedAt = started;
      const pending = narrate(
        {
          ...operationDefinition(operation),
          inputSchema: z.unknown().superRefine(checked)
        },
        count
      ).then((result) => {
        settled = true;
        finishedAt = Date.now();
        return result;
      });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(settled).toBe(true);
      const result = await pending;
      expect(finishedAt - started).toBeLessThanOrEqual(3_000);
      expect(result?.warnings).toHaveLength(count);
      for (let index = 0; index < count; index++) {
        expect(result?.warnings[index]).toContain(`“Check ${index}” may stop`);
      }
      expect(checked).toHaveBeenCalledTimes(Math.min(count, 4));
      // Let the already-started checks finish: no queued check starts after the deadline.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(checked).toHaveBeenCalledTimes(Math.min(count, 4));
    }
  );

  it("checks 50 delayed steps concurrently with a small bound before the budget ends", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const checked = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      active--;
    });
    let settled = false;
    const pending = narrate(
      {
        ...operationDefinition(operation),
        policyFloor: "deny",
        inputSchema: z.unknown().superRefine(checked)
      },
      50
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(settled).toBe(true);
    const result = await pending;
    expect(checked).toHaveBeenCalledTimes(50);
    expect(peak).toBe(4);
    expect(result?.warnings).toHaveLength(50);
    expect(result?.warnings.every((warning) => warning.includes("will be refused"))).toBe(true);
  });

  it("reads published guardrails once per narration and reads them fresh for the next", async () => {
    const onGuardrailRead = vi.fn();
    const instance = narrator({ onGuardrailRead });
    const input = {
      kind: "workflow",
      name: "checks",
      scope: workspaceScope,
      revision: 1,
      config: config(50),
      locale: "en" as const,
      access: everything
    };
    await instance.narrate(input);
    expect(onGuardrailRead).toHaveBeenCalledTimes(1);
    await instance.narrate(input);
    expect(onGuardrailRead).toHaveBeenCalledTimes(2);
  });
});
