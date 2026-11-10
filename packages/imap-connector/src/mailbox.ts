import { isIP } from "node:net";
import tls from "node:tls";
import { ImapFlow } from "imapflow";
import type {
  FetchMessageObject,
  ImapTransport,
  MessageAddressObject,
  MessageStructureObject,
  SearchObject
} from "imapflow";
import {
  AppError,
  connectionCallError,
  type ConnectorContext,
  type EgressGrant
} from "@work-shape/catalyst-core";
import type { ImapSettings } from "./settings";

// The adapter around the IMAP library. Its types stay in this file: the rest of the package
// reads the product types below. One session opens per call and logs out at its end.
//
// What is decided here:
// - Implicit TLS only, to the address the egress check pinned, with the configured host as the
//   TLS name and the certificate checked against it. The transport has no upgrade, so a server
//   that asks for STARTTLS gets none, and nothing goes out before the handshake.
// - Folders are opened with EXAMINE (read-only) and every body section is read with
//   BODY.PEEK, never BINARY: the server keeps every flag as it was.
// - The library logs nothing, and none of its errors leaves this file: some of them carry the
//   command as it was sent, a login's password included, or the server's text. A failure is
//   one reason of the platform's own.

/** One address as it is shown: `Name <address>`, the address, or the name. */
type MailAddress = string;

/** One part of a message's MIME structure. */
export interface MailPart {
  /** The IMAP section number, such as `1.2`; absent for the top of a one-part message. */
  part?: string;
  /** `type/subtype`, lower case. */
  type: string;
  encoding?: string;
  charset?: string;
  /** The encoded size the server reports. */
  size?: number;
  disposition?: string;
  filename?: string;
  children?: MailPart[];
}

export interface MailEnvelope {
  uid: number;
  date?: string;
  from: MailAddress[];
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  size?: number;
  seen: boolean;
  structure?: MailPart;
}

interface MailSearch {
  from?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  /** Only messages whose UID is lower: the page after a cursor. */
  belowUid?: number;
}

export interface MailboxSession {
  /** Opens one folder read-only. A folder the server does not have is `folder_not_found`. */
  examine(folder: string): Promise<{ uidValidity: string }>;
  /** The UIDs that match in the folder opened last, in any order. */
  search(criteria: MailSearch): Promise<number[]>;
  /** Envelope, flags, size and structure of these UIDs; one the server lacks is left out. */
  envelopes(uids: readonly number[]): Promise<MailEnvelope[]>;
  /** The raw bytes of these sections, each at most `maxBytes`, read without a flag change. */
  sections(
    uid: number,
    wanted: readonly { part: string; maxBytes: number }[]
  ): Promise<Map<string, Buffer>>;
  /** Logs out and closes the socket; never throws. */
  close(): Promise<void>;
}

/** How long the TCP and TLS setup and the greeting may take, within the call's deadline. */
const CONNECT_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 5_000;
/** How long the socket may stay silent. The call's own deadline is shorter. */
const SOCKET_TIMEOUT_MS = 20_000;
/** Bounds on what the server may send: one literal, one line, one response. */
const MAX_LITERAL_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** What the client says it is, where the server asks (RFC 2971). Nothing of the instance. */
const CLIENT_INFO = { name: "catalyst-imap-connector" };

/**
 * TLS to the pinned address. The configured host is the TLS name and the name the certificate
 * must hold; an address as the host is checked against the certificate's addresses. No
 * `upgrade`: a session never starts in plaintext.
 */
function pinnedTlsTransport(grant: EgressGrant): ImapTransport {
  return {
    connect(options, onConnect) {
      if (!options.secure) throw new Error("plaintext refused");
      return tls.connect(
        {
          host: grant.address,
          port: grant.port,
          ...(isIP(grant.host) === 0 ? { servername: grant.host } : {}),
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity: (_name, certificate) =>
            tls.checkServerIdentity(grant.host, certificate)
        },
        onConnect
      );
    }
  };
}

interface LibraryError {
  authenticationFailed?: boolean;
  mailboxMissing?: boolean;
  responseStatus?: string;
  code?: string;
}

function libraryErrorOf(error: unknown): LibraryError {
  if (typeof error !== "object" || error === null) return {};
  const read = (key: string): unknown => (key in error ? Reflect.get(error, key) : undefined);
  const flag = (key: string) => read(key) === true;
  const text = (key: string) => {
    const value = read(key);
    return typeof value === "string" ? value : undefined;
  };
  const responseStatus = text("responseStatus");
  const code = text("code");
  return {
    authenticationFailed: flag("authenticationFailed"),
    mailboxMissing: flag("mailboxMissing"),
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(code === undefined ? {} : { code })
  };
}

/**
 * The platform's reason for a failure of the library. An error the platform made, such as a
 * refusal of the egress check, passes as it is.
 */
function failureOf(error: unknown, signal: AbortSignal): AppError {
  if (error instanceof AppError) return error;
  if (signal.aborted) return connectionCallError("upstream_timeout");
  const failure = libraryErrorOf(error);
  if (failure.authenticationFailed === true) return connectionCallError("upstream_unauthorized");
  if (failure.code === "CONNECT_TIMEOUT" || failure.code === "GREETING_TIMEOUT")
    return connectionCallError("upstream_timeout");
  if (failure.responseStatus === "NO" || failure.responseStatus === "BAD")
    return connectionCallError("upstream_error");
  return connectionCallError("connection_unavailable");
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function addressesOf(list: readonly MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? []).flatMap((entry) => {
    const name = text(entry.name);
    const address = text(entry.address);
    if (name && address) return [`${name} <${address}>`];
    const one = address ?? name;
    return one === undefined ? [] : [one];
  });
}

function partOf(node: MessageStructureObject): MailPart {
  const filename =
    text(node.dispositionParameters?.filename) ?? text(node.parameters?.name) ?? undefined;
  return {
    ...(node.part === undefined ? {} : { part: node.part }),
    type: (text(node.type) ?? "application/octet-stream").toLowerCase(),
    ...(text(node.encoding) === undefined ? {} : { encoding: String(node.encoding).toLowerCase() }),
    ...(text(node.parameters?.charset) === undefined
      ? {}
      : { charset: String(node.parameters?.charset) }),
    ...(typeof node.size === "number" ? { size: node.size } : {}),
    ...(text(node.disposition) === undefined
      ? {}
      : { disposition: String(node.disposition).toLowerCase() }),
    ...(filename === undefined ? {} : { filename }),
    ...(node.childNodes === undefined ? {} : { children: node.childNodes.map(partOf) })
  };
}

function dateOf(message: FetchMessageObject): string | undefined {
  for (const value of [message.internalDate, message.envelope?.date]) {
    const date =
      value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
    if (date !== undefined && Number.isFinite(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function envelopeOf(message: FetchMessageObject): MailEnvelope {
  const envelope = message.envelope;
  return {
    uid: message.uid,
    ...(dateOf(message) === undefined ? {} : { date: dateOf(message) }),
    from: addressesOf(envelope?.from),
    replyTo: addressesOf(envelope?.replyTo),
    to: addressesOf(envelope?.to),
    cc: addressesOf(envelope?.cc),
    ...(text(envelope?.subject) === undefined ? {} : { subject: envelope?.subject }),
    ...(text(envelope?.messageId) === undefined ? {} : { messageId: envelope?.messageId }),
    ...(text(envelope?.inReplyTo) === undefined ? {} : { inReplyTo: envelope?.inReplyTo }),
    ...(typeof message.size === "number" ? { size: message.size } : {}),
    seen: message.flags?.has("\\Seen") === true,
    ...(message.bodyStructure === undefined ? {} : { structure: partOf(message.bodyStructure) })
  };
}

function searchQueryOf(criteria: MailSearch): SearchObject {
  return {
    ...(criteria.belowUid === undefined ? { all: true } : { uid: `1:${criteria.belowUid - 1}` }),
    ...(criteria.from === undefined ? {} : { from: criteria.from }),
    ...(criteria.subject === undefined ? {} : { subject: criteria.subject }),
    ...(criteria.text === undefined ? {} : { text: criteria.text }),
    ...(criteria.since === undefined ? {} : { since: criteria.since }),
    ...(criteria.before === undefined ? {} : { before: criteria.before })
  };
}

/**
 * Logs in to the mailbox over the context's checked target with the Connection's password. The
 * call's signal closes the session wherever it is.
 */
export async function openMailboxSession(
  context: ConnectorContext,
  settings: ImapSettings
): Promise<MailboxSession> {
  const { signal } = context;
  const password = context.credentialFor(context.target)?.secret;
  if (password === undefined) throw connectionCallError("connection_not_configured");
  if (signal.aborted) throw connectionCallError("upstream_timeout");
  const client = new ImapFlow({
    host: context.target.host,
    port: context.target.port,
    secure: true,
    doSTARTTLS: false,
    transport: pinnedTlsTransport(context.target),
    auth: { user: settings.username, pass: password },
    logger: false,
    emitLogs: false,
    clientInfo: CLIENT_INFO,
    disableAutoIdle: true,
    disableCompression: true,
    disableAutoEnable: true,
    disableBinary: true,
    qresync: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    maxLiteralSize: MAX_LITERAL_BYTES,
    maxLineLength: MAX_LINE_BYTES,
    maxResponseSize: MAX_RESPONSE_BYTES
  });
  // An error event without a listener would end the process. What it says is not read.
  client.on("error", () => undefined);
  const stop = () => client.close();
  signal.addEventListener("abort", stop, { once: true });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", stop);
    try {
      if (!signal.aborted && client.usable) await client.logout();
    } catch {
      // The session is closed below either way.
    } finally {
      client.close();
    }
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw failureOf(error, signal);
    }
  };
  try {
    await client.connect();
  } catch (error) {
    await close();
    throw failureOf(error, signal);
  }
  return {
    async examine(folder) {
      try {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        return { uidValidity: String(mailbox.uidValidity) };
      } catch (error) {
        const failure = libraryErrorOf(error);
        if (!signal.aborted && (failure.mailboxMissing === true || failure.responseStatus === "NO"))
          throw connectionCallError("folder_not_found");
        throw failureOf(error, signal);
      }
    },
    search: (criteria) =>
      run(async () => {
        if (criteria.belowUid !== undefined && criteria.belowUid <= 1) return [];
        const found = await client.search(searchQueryOf(criteria), { uid: true });
        return Array.isArray(found) ? found : [];
      }),
    envelopes: (uids) =>
      run(async () => {
        if (uids.length === 0) return [];
        const messages = await client.fetchAll(
          uids.join(","),
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
            size: true,
            internalDate: true
          },
          { uid: true }
        );
        return messages.map(envelopeOf);
      }),
    sections: (uid, wanted) =>
      run(async () => {
        const found = new Map<string, Buffer>();
        if (wanted.length === 0) return found;
        const message = await client.fetchOne(
          String(uid),
          {
            uid: true,
            bodyParts: wanted.map(({ part, maxBytes }) => ({ key: part, maxLength: maxBytes }))
          },
          { uid: true }
        );
        if (message === false) return found;
        for (const { part, maxBytes } of wanted) {
          const bytes = message.bodyParts?.get(part);
          if (bytes !== undefined) found.set(part, bytes.subarray(0, maxBytes));
        }
        return found;
      }),
    close
  };
}
