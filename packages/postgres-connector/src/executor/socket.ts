import net from "node:net";
import tls from "node:tls";
import { PostgresExecutorError } from "./errors";

/**
 * Where a database is and how it is reached. It holds no credential: the password is resolved
 * from a credential handle whenever a connection is opened.
 */
export interface PostgresLocation {
  host: string;
  port: number;
  database: string;
  user: string;
  /** `off` is for a target on the instance's own private network only. */
  tls: "verify-full" | "off";
  /** PEM certificates to trust instead of the system roots. */
  caBundle?: string;
  /** The schemas unqualified names resolve through, and the ones `describe` lists. */
  schemas: readonly string[];
}

export type PinnedPostgresAddress = { allowed: true; address: string } | { allowed: false };

/**
 * The address check of the platform's egress rules. It is asked before every socket and
 * answers with the one IP address to dial, or refuses the target.
 */
export type PinPostgresAddress = (host: string, port: number) => Promise<PinnedPostgresAddress>;

/** How one socket to a database is opened: where it dials and what TLS verifies. */
export interface PostgresSocketPlan {
  socket: { host: string; port: number };
  tls?: {
    /** The name the certificate is checked against. It is never resolved again. */
    host: string;
    /** The name sent to the server. Absent for an IP literal, which TLS cannot send. */
    servername?: string;
    rejectUnauthorized: true;
    ca?: string;
  };
}

export function planPostgresSocket(
  location: PostgresLocation,
  pinnedAddress: string
): PostgresSocketPlan {
  const socket = { host: pinnedAddress, port: location.port };
  if (location.tls === "off") return { socket };
  return {
    socket,
    tls: {
      host: location.host,
      ...(net.isIP(location.host) === 0 ? { servername: location.host } : {}),
      rejectUnauthorized: true,
      ...(location.caBundle === undefined ? {} : { ca: location.caBundle })
    }
  };
}

export interface PostgresSocketRoute {
  location: PostgresLocation;
  pinAddress: PinPostgresAddress;
}

/**
 * Opens one socket to the database: the address check first, then TCP to the pinned address,
 * then TLS when the location asks for it. Nothing of the credential has been sent or resolved
 * when this returns or fails. Aborting the signal ends the address check, the attempt and, at
 * any later time, the socket.
 */
export async function openPostgresSocket(
  route: PostgresSocketRoute,
  signal: AbortSignal
): Promise<net.Socket> {
  const address = await pinnedAddress(route, signal);
  const plan = planPostgresSocket(route.location, address);
  const { socket, leaveSocket } = await connect(plan.socket, signal);
  if (plan.tls === undefined) return socket;
  let secured: tls.TLSSocket;
  try {
    await requestTls(socket);
    secured = await secure(socket, plan.tls);
  } catch {
    socket.destroy();
    throw new PostgresExecutorError("tls_failed");
  }
  // From here the TLS socket is the one to end. Taking the TCP socket away underneath it
  // would leave it to fail on a write nobody expects.
  leaveSocket();
  destroyOnAbort(secured, signal);
  return secured;
}

const ignore = (): void => undefined;

/**
 * An error of a socket ends the call that waits on it. What must never happen is an error
 * with no listener, which ends the process. The driver drops every listener of a socket that
 * closed, so the listener is set again after it.
 */
function hearErrors(socket: net.Socket): void {
  socket.on("error", ignore);
  socket.once("close", () => process.nextTick(() => socket.on("error", ignore)));
}

/** Returns how to take the binding away again. */
function destroyOnAbort(socket: net.Socket, signal: AbortSignal): () => void {
  const destroy = () => socket.destroy();
  const leave = () => signal.removeEventListener("abort", destroy);
  signal.addEventListener("abort", destroy, { once: true });
  socket.once("close", leave);
  if (signal.aborted) destroy();
  return leave;
}

async function pinnedAddress(
  { location, pinAddress }: PostgresSocketRoute,
  signal: AbortSignal
): Promise<string> {
  let pinned: PinnedPostgresAddress;
  try {
    pinned = await untilAborted(pinAddress(location.host, location.port), signal);
  } catch {
    throw new PostgresExecutorError("unavailable");
  }
  // A name here would be resolved a second time by the socket, past the check.
  if (!pinned.allowed || net.isIP(pinned.address) === 0) {
    throw new PostgresExecutorError("network_denied");
  }
  return pinned.address;
}

/** The address check is the platform's, and it may hang. The abort ends the wait for it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new PostgresExecutorError("unavailable"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** The socket, and how to take away the binding that destroys it on abort. */
function connect(
  target: { host: string; port: number },
  signal: AbortSignal
): Promise<{ socket: net.Socket; leaveSocket: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target);
    const refuse = () => reject(new PostgresExecutorError("unavailable"));
    hearErrors(socket);
    socket.once("close", refuse);
    socket.once("connect", () => {
      socket.off("close", refuse);
      resolve({ socket, leaveSocket });
    });
    const leaveSocket = destroyOnAbort(socket, signal);
  });
}

/** The SSLRequest message: length 8, code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const SSL_ACCEPTED = 0x53;

/**
 * Asks the server for TLS and insists on its one-byte yes. A no, and anything sent along with
 * the answer before the handshake, ends the attempt.
 */
function requestTls(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const refuse = () => reject(new Error("The server did not accept TLS"));
    socket.once("close", refuse);
    socket.once("data", (answer: Buffer) => {
      socket.off("close", refuse);
      if (answer.length === 1 && answer[0] === SSL_ACCEPTED) resolve();
      else refuse();
    });
    socket.write(SSL_REQUEST);
  });
}

function secure(
  socket: net.Socket,
  options: NonNullable<PostgresSocketPlan["tls"]>
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, ...options });
    const refuse = () => reject(new Error("The TLS handshake did not complete"));
    secured.once("close", refuse);
    hearErrors(secured);
    secured.once("close", refuse);
    secured.once("secureConnect", () => {
      secured.off("close", refuse);
      resolve(secured);
    });
  });
}

/** What a server needs to be told to cancel the query one of its backends is running. */
export interface PostgresBackendKey {
  pid: number;
  secret: number;
}

/**
 * Tells the server to cancel the query of one backend, over a socket of its own that passes
 * the same address check and TLS. Resolves when the server has taken the request or the wait
 * is over. It never fails: the caller discards the connection either way.
 */
export async function requestPostgresCancel(
  route: PostgresSocketRoute,
  key: PostgresBackendKey,
  waitMs: number
): Promise<void> {
  const wait = new AbortController();
  const timer = setTimeout(() => wait.abort(), waitMs);
  try {
    const socket = await openPostgresSocket(route, wait.signal);
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.write(cancelRequest(key));
    });
  } catch {
    // The target refused or could not be reached. The caller destroys the connection next.
  } finally {
    clearTimeout(timer);
  }
}

/** The CancelRequest message: length 16, code 80877102, process id, secret key. */
function cancelRequest(key: PostgresBackendKey): Buffer {
  const message = Buffer.alloc(16);
  message.writeUInt32BE(16, 0);
  message.writeUInt32BE(80877102, 4);
  message.writeUInt32BE(key.pid, 8);
  message.writeUInt32BE(key.secret, 12);
  return message;
}
