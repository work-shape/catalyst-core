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
 * when this returns or fails. Aborting the signal destroys the socket at any later time.
 */
export async function openPostgresSocket(
  route: PostgresSocketRoute,
  signal: AbortSignal
): Promise<net.Socket> {
  const address = await pinnedAddress(route);
  const plan = planPostgresSocket(route.location, address);
  const socket = await connect(plan.socket, signal);
  if (plan.tls === undefined) return socket;
  try {
    await requestTls(socket);
    return await secure(socket, plan.tls);
  } catch {
    socket.destroy();
    throw new PostgresExecutorError("tls_failed");
  }
}

async function pinnedAddress({ location, pinAddress }: PostgresSocketRoute): Promise<string> {
  let pinned: PinnedPostgresAddress;
  try {
    pinned = await pinAddress(location.host, location.port);
  } catch {
    throw new PostgresExecutorError("unavailable");
  }
  // A name here would be resolved a second time by the socket, past the check.
  if (!pinned.allowed || net.isIP(pinned.address) === 0) {
    throw new PostgresExecutorError("network_denied");
  }
  return pinned.address;
}

function connect(target: { host: string; port: number }, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ ...target, signal });
    const refuse = () => reject(new PostgresExecutorError("unavailable"));
    socket.once("error", refuse);
    socket.once("connect", () => {
      socket.off("error", refuse);
      // An abort after this point destroys the socket with an error nobody else may hear.
      socket.on("error", () => undefined);
      resolve(socket);
    });
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
    secured.once("error", refuse);
    secured.once("close", refuse);
    secured.once("secureConnect", () => {
      secured.off("error", refuse);
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
      socket.on("error", () => undefined);
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
