import type { PlatformStores } from "@vivd-catalyst/core";
import postgres from "postgres";

/**
 * Helpers that force an order between two real store calls on separate connections without
 * sleeping for it. The test holds a transaction open that pins the first call in the middle of
 * its own transaction, waits until Postgres reports the second call as blocked by the first,
 * and only then lets go.
 */

export interface HeldTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

class HeldTransactionRollback extends Error {}

/** Appends an application name, so that a pool's backends can be found in `pg_stat_activity`. */
export function databaseUrlFor(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

/**
 * Opens a transaction, runs `prepare` in it and keeps it open until the returned handle commits
 * it or rolls it back.
 */
export async function holdTransaction(
  sql: postgres.Sql,
  prepare: (tx: postgres.TransactionSql) => Promise<unknown>
): Promise<HeldTransaction> {
  let decide: (outcome: "commit" | "rollback") => void = () => undefined;
  const decided = new Promise<"commit" | "rollback">((resolve) => {
    decide = resolve;
  });
  let markPrepared: () => void = () => undefined;
  let markFailed: (error: unknown) => void = () => undefined;
  const prepared = new Promise<void>((resolve, reject) => {
    markPrepared = resolve;
    markFailed = reject;
  });
  const finished = sql
    .begin(async (tx) => {
      await prepare(tx);
      markPrepared();
      if ((await decided) === "rollback") {
        throw new HeldTransactionRollback();
      }
    })
    .then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof HeldTransactionRollback)) {
          markFailed(error);
          throw error;
        }
      }
    );
  finished.catch(() => undefined);
  await prepared;
  return {
    async commit() {
      decide("commit");
      await finished;
    },
    async rollback() {
      decide("rollback");
      await finished;
    }
  };
}

/**
 * Resolves once a backend of `waiter` waits for a lock that a backend of `holder` holds, as
 * `pg_locks` reports it. Fails when that does not happen.
 */
export async function waitUntilBlocked(
  observer: postgres.Sql,
  input: { waiter: string; holder: string }
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const [row] = await observer<Array<{ waiting: number }>>`
      select count(*)::int as waiting
      from pg_locks blocked
      join pg_stat_activity waiter on waiter.pid = blocked.pid
      where not blocked.granted
        and waiter.application_name = ${input.waiter}
        and exists (
          select 1
          from pg_stat_activity holder
          where holder.pid = any(pg_blocking_pids(blocked.pid))
            and holder.application_name = ${input.holder}
        )
    `;
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${input.waiter} never waited for a lock held by ${input.holder}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Starts a call and keeps its outcome, so that a rejection is never left unhandled. */
export async function settled<T>(call: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([call]);
  return result;
}

/** Hold the first operation's row locks until Postgres proves the second is waiting. */
export async function orderedStoreCalls<A, B>(
  observer: postgres.Sql,
  input: { first: PlatformStores; firstName: string; secondName: string },
  first: (stores: PlatformStores) => Promise<A>,
  second: () => Promise<B>
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  let failed: (error: unknown) => void = () => undefined;
  const prepared = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const firstResult = settled(
    input.first
      .transaction(async (stores) => {
        const result = await first(stores);
        ready();
        await released;
        return result;
      })
      .catch((error: unknown) => {
        failed(error);
        throw error;
      })
  );
  let secondResult: Promise<PromiseSettledResult<B>> | undefined;
  try {
    await prepared;
    secondResult = settled(second());
    await waitUntilBlocked(observer, { waiter: input.secondName, holder: input.firstName });
  } finally {
    release();
    // Always drain both operations, including a failed observation or setup.
    await Promise.all([firstResult, secondResult]);
  }
  if (secondResult === undefined) throw new Error("The second operation was never started");
  return [await firstResult, await secondResult];
}
