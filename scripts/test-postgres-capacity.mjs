// How many Postgres connections a test run may hold at once, and what follows from that on
// both sides: how many connections `pnpm check:local` gives its server, and how many test
// files `vitest.config.ts` runs side by side on a server it did not start.
//
//   workers * (TEST_FILE_CONNECTION_BUDGET + TEST_WORKER_ADMIN_CONNECTIONS)
//     + SERVER_RESERVED_CONNECTIONS  <=  max_connections
//
// One worker runs one test file at a time on a database of its own. On 16 cores that is
// 15 * (40 + 1) + 3 = 618 connections for `pnpm check:local`. A server left at Postgres's
// default of 100 has room for (100 - 3) / 41 = 2 workers.
import { availableParallelism } from "node:os";

/**
 * The connections one test file may hold at once: every pool of every instance it has open,
 * and its raw connections. Measured over a whole run from the server's connection log on
 * 2026-10-10: 148 of 156 files stayed under 10, the three highest were
 * `chat-server-origins` at 32, `usage-admission-race` at 31 and `workspace-tools` at 26.
 * A file that needs more raises this number; nothing else follows from it by hand.
 */
export const TEST_FILE_CONNECTION_BUDGET = 40;

/**
 * Beside its file database a worker holds one connection to the administrative database
 * while it creates, resets or drops that file database.
 */
export const TEST_WORKER_ADMIN_CONNECTIONS = 1;

/** Postgres keeps `superuser_reserved_connections` free of ordinary roles: 3 by default. */
export const SERVER_RESERVED_CONNECTIONS = 3;

/** The test files Vitest runs side by side when nothing limits it: one core stays free. */
export function defaultTestWorkers() {
  return Math.max(availableParallelism() - 1, 1);
}

/**
 * The `max_connections` a server needs for this many workers.
 * @param {number} workers
 */
export function connectionsForWorkers(workers) {
  return (
    workers * (TEST_FILE_CONNECTION_BUDGET + TEST_WORKER_ADMIN_CONNECTIONS) +
    SERVER_RESERVED_CONNECTIONS
  );
}

/**
 * The workers a server with this `max_connections` has room for. Never fewer than one: a
 * server too small for one file fails that file, which says so.
 * @param {number} maxConnections
 */
export function workersForConnections(maxConnections) {
  return Math.max(
    Math.floor(
      (maxConnections - SERVER_RESERVED_CONNECTIONS) /
        (TEST_FILE_CONNECTION_BUDGET + TEST_WORKER_ADMIN_CONNECTIONS)
    ),
    1
  );
}
