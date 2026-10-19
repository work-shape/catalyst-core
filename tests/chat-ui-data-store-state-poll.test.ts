// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { useDataStoreSource } from "@work-shape/catalyst-chat-ui/build-area";
import { mountPage, SETTINGS_INSTANCE_URL, settingsPageContext } from "./chat-ui-settings-fixtures";

// LOWS-A: a store's page reads its state again every 3 seconds while it is set up or migrated,
// stops once it settled, and stops ten minutes after its first unsettled answer for a store
// that never settles, by the clock, also where every later read fails. Each store the page
// opens gets ten minutes of its own.

const POLL_MS = 3_000;
const MINUTE_MS = 60_000;
const MAX_MS = 10 * MINUTE_MS;

function storeState(name: string, outcome: "pending" | "applied") {
  return {
    id: `asset_${name}`,
    name,
    status: "ready",
    level: 1,
    publishedLevel: 2,
    size: { limitBytes: 500 * 1024 * 1024, nearLimit: false },
    conditions: [],
    lastMigration: { outcome, migration: { number: 2, name: "add_total" } }
  };
}

/**
 * The store page's state read against an instance whose migrations the test settles and whose
 * reads it can make fail. `open` shows another store, as the page does when one is picked.
 */
async function mountStateRead() {
  const instance = {
    reads: { orders: 0, invoices: 0 } as Record<string, number>,
    outcome: "pending" as "pending" | "applied",
    failing: false
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const store = /^\/api\/v1\/data-stores\/([^/]+)$/u.exec(
      new URL(new Request(input, init).url).pathname
    )?.[1];
    if (store === undefined) return new Response(null, { status: 404 });
    instance.reads[store] = (instance.reads[store] ?? 0) + 1;
    if (instance.failing) {
      return Response.json(
        { error: { code: "INTERNAL", message: "down", correlationId: "corr_1" } },
        { status: 500 }
      );
    }
    return Response.json(storeState(store, instance.outcome));
  };
  const shown: { open?: (store: string) => void } = {};
  function Probe() {
    const [store, setStore] = useState("orders");
    shown.open = setStore;
    useDataStoreSource().useStoreState(store);
    return null;
  }
  const page = await mountPage(
    settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl })),
    "en",
    createElement(Probe)
  );
  const pass = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const open = async (store: string) => {
    await act(async () => {
      shown.open?.(store);
    });
    await pass(0);
  };
  await pass(0);
  return { instance, pass, open, unmount: page.unmount };
}

describe("the state read of a Data Store", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads again while the store settles and stops once it settled", async () => {
    const { instance, pass, unmount } = await mountStateRead();
    expect(instance.reads.orders).toBe(1);
    await pass(POLL_MS);
    await pass(POLL_MS);
    expect(instance.reads.orders).toBe(3);
    instance.outcome = "applied";
    await pass(POLL_MS);
    expect(instance.reads.orders).toBe(4);
    await pass(POLL_MS * 10);
    expect(instance.reads.orders).toBe(4);
    await unmount();
  });

  it("stops reading a store that never settles after ten minutes", async () => {
    const { instance, pass, unmount } = await mountStateRead();
    await pass(MAX_MS - POLL_MS);
    expect(instance.reads.orders).toBeGreaterThan(MAX_MS / POLL_MS - 5);
    await pass(POLL_MS * 2);
    const atCeiling = instance.reads.orders;
    await pass(MAX_MS);
    expect(instance.reads.orders).toBe(atCeiling);
    expect(atCeiling).toBeLessThanOrEqual(MAX_MS / POLL_MS + 2);
    await unmount();
  });

  // A failed read changes no answer, so a bound measured between answers never came.
  it("stops after ten minutes where every read after the first unsettled answer fails", async () => {
    const { instance, pass, unmount } = await mountStateRead();
    instance.failing = true;
    await pass(MINUTE_MS);
    // It keeps trying while the reads fail, inside the ten minutes.
    expect(instance.reads.orders).toBeGreaterThan(MINUTE_MS / POLL_MS - 2);
    await pass(MAX_MS);
    const atCeiling = instance.reads.orders;
    expect(atCeiling).toBeLessThanOrEqual(MAX_MS / POLL_MS + 2);
    await pass(MAX_MS * 2);
    expect(instance.reads.orders).toBe(atCeiling);
    await unmount();
  });

  it("gives each unsettled store it opens ten minutes of its own", async () => {
    const { instance, pass, open, unmount } = await mountStateRead();
    await pass(MINUTE_MS);
    await open("invoices");
    await pass(4 * MINUTE_MS);
    expect(instance.reads.invoices).toBeGreaterThan((4 * MINUTE_MS) / POLL_MS - 2);
    // Back to orders within the query cache's five minutes, so its unsettled answer is still
    // held: it gets a window from now, not the one invoices began a minute in.
    await open("orders");
    await pass(7 * MINUTE_MS);
    const ordersAt7 = instance.reads.orders ?? 0;
    await pass(2 * MINUTE_MS);
    expect(instance.reads.orders).toBeGreaterThan(ordersAt7);
    await pass(2 * MINUTE_MS);
    const ordersAtCeiling = instance.reads.orders;
    await pass(MAX_MS);
    expect(instance.reads.orders).toBe(ordersAtCeiling);
    await unmount();
  });
});
