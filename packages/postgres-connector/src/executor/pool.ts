import type net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import type { JsonObject, ScopedSecretResolver } from "@vivd-catalyst/core";
import { PostgresExecutorError, type PostgresExecutorErrorKind } from "./errors";
import {
  POSTGRES_CANCEL_REPEAT_MS,
  POSTGRES_CONNECT_TIMEOUT_SECONDS,
  POSTGRES_CONNECTION_MAX_LIFETIME_SECONDS,
  POSTGRES_POOL_ACQUIRE_WAIT_MS,
  POSTGRES_POOL_IDLE_CLOSE_SECONDS
} from "./limits";
import type { BoundPostgresParameter } from "./parameters";
import {
  openPostgresSocket,
  requestPostgresCancel,
  type PostgresBackendKey,
  type PostgresSocketRoute
} from "./socket";
import { postgresRowKeys, postgresValueReader, readPostgresRow } from "./values";

/** A row as the server sent it: the text of each column in order, or null. */
export type PostgresTextRow = readonly unknown[];

/** What the executor does on one connection. The driver stays behind it. */
export interface PostgresSession {
  /**
   * Runs a statement of the executor's own and returns all of its rows, each scalar read by
   * its type. An array column stays the server's text.
   */
  run(text: string, parameters?: readonly BoundPostgresParameter[]): Promise<JsonObject[]>;
  /** The result columns of a statement, without running it. */
  columns(
    text: string,
    parameters: readonly BoundPostgresParameter[]
  ): Promise<{ name: string; typeOid: number }[]>;
  /** Reads a statement in batches. Leaving the loop early closes the cursor on the server. */
  cursor(
    text: string,
    parameters: readonly BoundPostgresParameter[],
    batchRows: number
  ): AsyncIterable<PostgresTextRow[]>;
  /** True once the call read more from the socket than it may. The connection is closed then. */
  readonly readLimitPassed: boolean;
}

export interface PostgresConnectionSource extends PostgresSocketRoute {
  secrets: ScopedSecretResolver;
  credentialHandle: string;
}

const asText = (value: string): string => value;

/**
 * Takes the driver's own reading and writing of values away. Every value arrives as the
 * server's text and is read by `values.ts`, and a parameter goes out as the text the executor
 * wrote, never encoded again by the type the server inferred for it.
 */
const TEXT_ONLY = {
  text: {
    to: 25,
    from: [16, 17, 21, 23, 26, 114, 700, 701, 1082, 1114, 1184, 3802],
    serialize: asText,
    parse: asText
  }
};

/**
 * One connection to a customer's database. It opens lazily, through the address check, and
 * asks for the password only when the server asks for it, so the password is in no field.
 */
export class PostgresConnection implements PostgresSession {
  private readonly source: PostgresConnectionSource;
  private readonly closed = new AbortController();
  private readonly sql: ReturnType<typeof postgres<typeof TEXT_ONLY>>;
  private socket: net.Socket | undefined;
  private backend: PostgresBackendKey | undefined;
  private readBytes = 0;
  private readLimitBytes = Number.POSITIVE_INFINITY;
  private pastReadLimit = false;

  constructor(source: PostgresConnectionSource) {
    this.source = source;
    const { location } = source;
    // The driver reads `socket` and opens no socket of its own once it is set. Its types do
    // not list the option, nor `max_pipeline`.
    const options: postgres.Options<typeof TEXT_ONLY> & {
      socket: () => Promise<net.Socket>;
      max_pipeline: number;
    } = {
      socket: () => this.openSocket(),
      // Never dialled, and so not the customer's name: every socket comes from `socket` above.
      host: "pinned-by-the-executor",
      port: location.port,
      database: location.database,
      user: location.user,
      password: () => this.password(),
      // TLS is settled on the socket before the driver sees it.
      ssl: false,
      // One connection, so that the transaction, the cursor and the rollback share it.
      max: 1,
      idle_timeout: POSTGRES_POOL_IDLE_CLOSE_SECONDS,
      // The driver fills every setting that is not named here from a `PG...` variable of the
      // process. These are its own defaults, named so that no such variable applies.
      connect_timeout: POSTGRES_CONNECT_TIMEOUT_SECONDS,
      max_lifetime: POSTGRES_CONNECTION_MAX_LIFETIME_SECONDS,
      max_pipeline: 100,
      keep_alive: 60,
      backoff: () => 1,
      // Unnamed statements: nothing prepared stays behind on the customer's server.
      prepare: false,
      // Arrays are read by the executor, which asks the catalog for the types of a result.
      fetch_types: false,
      debug: false,
      // A notice can quote a row. The driver would print it.
      onnotice: () => undefined,
      connection: { application_name: "catalyst", TimeZone: "UTC", DateStyle: "ISO" },
      types: TEXT_ONLY
    };
    this.sql = postgres(options);
    // The one setting the driver takes from the process even when it is named here. It makes
    // the driver drop and reopen connections by the state of the server, so it is refused.
    if (this.sql.options.target_session_attrs) {
      this.closed.abort();
      throw new PostgresExecutorError("failed");
    }
  }

  get readLimitPassed(): boolean {
    return this.pastReadLimit;
  }

  /**
   * Opens the read-only transaction and notes which backend runs it. From here the call may
   * read `readLimitBytes` from the socket. One byte more closes the connection.
   */
  async beginReadOnly(readLimitBytes: number): Promise<void> {
    this.readBytes = 0;
    this.readLimitBytes = readLimitBytes;
    // The driver may have reconnected since the last call, to another backend.
    this.backend = undefined;
    const begun = await this.sql.unsafe("begin read only");
    this.backend = { pid: begun.state.pid, secret: begun.state.secret };
  }

  async run(
    text: string,
    parameters: readonly BoundPostgresParameter[] = []
  ): Promise<JsonObject[]> {
    const result = await this.sql.unsafe(text, this.driverParameters(parameters)).values();
    if (result.length === 0) return [];
    const keys = postgresRowKeys(result.columns.map((column) => column.name));
    const columns = result.columns.map((column, index) => ({
      key: keys[index] ?? column.name,
      read: postgresValueReader({ oid: column.type })
    }));
    return result.map((row) => readPostgresRow(row, columns));
  }

  async columns(
    text: string,
    parameters: readonly BoundPostgresParameter[]
  ): Promise<{ name: string; typeOid: number }[]> {
    const statement = await this.sql.unsafe(text, this.driverParameters(parameters)).describe();
    return statement.columns.map((column) => ({ name: column.name, typeOid: column.type }));
  }

  cursor(
    text: string,
    parameters: readonly BoundPostgresParameter[],
    batchRows: number
  ): AsyncIterable<PostgresTextRow[]> {
    return this.sql.unsafe(text, this.driverParameters(parameters)).values().cursor(batchRows);
  }

  /**
   * Ends on the server what this connection's backend is running, within `waitMs`. Destroying
   * the socket alone would leave a query running on the customer's server.
   *
   * The socket is closed for writing first, so nothing more is asked of the backend, and the
   * backend leaves once it reads that. A cancel request ends only the statement that runs at
   * the moment it arrives, and one already on its way may start after it. So the request is
   * repeated until the server has closed the socket, which is the backend saying it is gone.
   */
  async cancelRunningQuery(waitMs: number): Promise<void> {
    const { backend, socket } = this;
    if (!backend) return;
    const until = performance.now() + waitMs;
    let gone = socket === undefined || socket.destroyed;
    socket?.once("close", () => {
      gone = true;
    });
    socket?.end();
    for (let left = waitMs; !gone && left > 0; left = until - performance.now()) {
      await requestPostgresCancel(this.source, backend, left);
      if (!gone) await delay(Math.min(POSTGRES_CANCEL_REPEAT_MS, left));
    }
  }

  /** Drops the connection at once. Whatever still waits on it fails. */
  destroy(): void {
    this.closed.abort();
    void this.sql.end({ timeout: 0 }).catch(() => undefined);
  }

  /** Closes the connection after what it is doing, for an idle connection at shutdown. */
  async end(): Promise<void> {
    await this.sql.end({ timeout: 1 });
    this.closed.abort();
  }

  private driverParameters(parameters: readonly BoundPostgresParameter[]) {
    return parameters.map((parameter) => this.sql.typed(parameter.text, parameter.oid));
  }

  private async openSocket(): Promise<net.Socket> {
    if (this.closed.signal.aborted) throw new PostgresExecutorError("unavailable");
    const socket = await openPostgresSocket(this.source, this.closed.signal);
    // The driver holds a whole message before it hands a row on, so only a count on the
    // socket sees a value that is too large while it still arrives.
    socket.on("data", (chunk: Buffer) => this.countRead(chunk.length));
    this.socket = socket;
    return socket;
  }

  private countRead(bytes: number): void {
    this.readBytes += bytes;
    if (this.readBytes <= this.readLimitBytes || this.pastReadLimit) return;
    this.pastReadLimit = true;
    // Ends the socket and keeps the driver from opening another.
    this.closed.abort();
  }

  /**
   * Called by the driver when the server asks for the password, once per physical connection.
   * The driver cannot take a failure here, so a credential that does not resolve ends the
   * socket with the reason and leaves the driver's question unanswered.
   */
  private async password(): Promise<string> {
    let password: string | undefined;
    try {
      password = await this.source.secrets.getSecret(this.source.credentialHandle);
    } catch {
      return this.endSocket("failed");
    }
    return password ?? this.endSocket("unauthorized");
  }

  private endSocket(kind: Extract<PostgresExecutorErrorKind, "failed" | "unauthorized">) {
    this.socket?.destroy(new PostgresExecutorError(kind));
    return new Promise<never>(() => undefined);
  }
}

interface Waiter {
  maxConnections: number;
  grant(connection: PostgresConnection): void;
}

/**
 * The connections to one database under one credential. It never holds more connections than
 * the caller's limit, and a call that finds none free waits a bounded time and then fails as
 * `busy`. The driver's own queue has no bound, so the wait is kept here.
 */
export class PostgresPool {
  private readonly open: () => PostgresConnection;
  private readonly idle: PostgresConnection[] = [];
  private readonly waiters: Waiter[] = [];
  private inUse = 0;

  constructor(open: () => PostgresConnection) {
    this.open = open;
  }

  acquire(maxConnections: number, signal?: AbortSignal): Promise<PostgresConnection> {
    if (signal?.aborted) return Promise.reject(new PostgresExecutorError("cancelled"));
    if (this.inUse < maxConnections) return Promise.resolve(this.take());
    return new Promise((resolve, reject) => {
      const leave = (kind: "busy" | "cancelled") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new PostgresExecutorError(kind));
      };
      const onAbort = () => leave("cancelled");
      const timer = setTimeout(() => leave("busy"), POSTGRES_POOL_ACQUIRE_WAIT_MS);
      const waiter: Waiter = {
        maxConnections,
        grant: (connection) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(connection);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Returns a connection whose transaction was rolled back. */
  release(connection: PostgresConnection): void {
    this.inUse -= 1;
    this.idle.push(connection);
    this.grantNext();
  }

  /** Drops a connection that cannot be trusted to be clean. Its place is free again. */
  discard(connection: PostgresConnection): void {
    this.inUse -= 1;
    connection.destroy();
    this.grantNext();
  }

  async close(): Promise<void> {
    await Promise.all(this.idle.splice(0).map((connection) => connection.end()));
  }

  private take(): PostgresConnection {
    const connection = this.idle.pop() ?? this.open();
    this.inUse += 1;
    return connection;
  }

  private grantNext(): void {
    const index = this.waiters.findIndex((waiter) => this.inUse < waiter.maxConnections);
    const [waiter] = index === -1 ? [] : this.waiters.splice(index, 1);
    waiter?.grant(this.take());
  }
}
