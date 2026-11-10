import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket
} from "node:net";
import { createServer as createTlsServer } from "node:tls";
import type { TestCertificate } from "./test-certificate";

// An IMAP server in this process, for the Connector type `imap`. It speaks as much of IMAP4rev1
// as the connector needs (LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH, LOGOUT), keeps every
// command it was sent, and changes flags the way a real server does: a fetch of BODY[...]
// without PEEK and a STORE mark a message as seen, so a test sees when a client changed one.
// Accounts and mail are made up by each test.

interface FakeAddress {
  name?: string;
  mailbox: string;
  host: string;
}

interface FakePart {
  /** `type/subtype`, such as `text/plain`. */
  type: string;
  charset?: string;
  /** The transfer encoding the body is written in. 7bit where left out. */
  encoding?: string;
  disposition?: "inline" | "attachment";
  filename?: string;
  /** The part's body as it travels, already in its transfer encoding. */
  body?: string | Buffer;
  children?: FakePart[];
}

export interface FakeMessage {
  uid: number;
  flags?: string[];
  date?: Date;
  subject?: string;
  from?: FakeAddress[];
  replyTo?: FakeAddress[];
  to?: FakeAddress[];
  cc?: FakeAddress[];
  messageId?: string;
  inReplyTo?: string;
  body: FakePart;
}

export interface FakeFolder {
  uidValidity: number;
  messages: FakeMessage[];
}

export interface ImapTestServerOptions {
  /** TLS from the first byte with this certificate; `false` speaks plain IMAP on the port. */
  tls: TestCertificate | false;
  account: { username: string; password: string };
  folders: Record<string, FakeFolder>;
  /** Capabilities beside IMAP4rev1, such as `STARTTLS`. */
  capabilities?: string[];
}

interface ImapCommand {
  /** Upper case, with `UID` joined: `UID FETCH`. */
  name: string;
  /** The arguments as the client sent them, literals inlined. */
  args: string;
}

export interface ImapTestServer {
  port: number;
  /** Every command of every session, in order. */
  readonly commands: ImapCommand[];
  /** TCP connections the server accepted. */
  readonly connections: () => number;
  /** The TLS names the clients asked for. */
  readonly serverNames: (string | false)[];
  /** The flags of one message now. */
  flagsOf(folder: string, uid: number): string[];
  /** Folders of the account, which a test may change between calls. */
  readonly folders: Record<string, FakeFolder>;
  close(): Promise<void>;
}

/** One value of a command: an atom, a string or a list. */
type Token = { atom: string } | { string: string } | { list: Token[] };

function quote(value: string | undefined): string {
  if (value === undefined) return "NIL";
  // Anything that is not plain ASCII goes as a literal, as a server sends it.
  if (/^[\x20-\x7e]*$/u.test(value) && !/["\\]/u.test(value)) return `"${value}"`;
  return `{${Buffer.byteLength(value)}}\r\n${value}`;
}

function addresses(list: FakeAddress[] | undefined): string {
  if (list === undefined || list.length === 0) return "NIL";
  return `(${list
    .map((entry) => `(${quote(entry.name)} NIL ${quote(entry.mailbox)} ${quote(entry.host)})`)
    .join("")})`;
}

function bodyBytes(part: FakePart): Buffer {
  return typeof part.body === "string"
    ? Buffer.from(part.body, "utf8")
    : (part.body ?? Buffer.alloc(0));
}

function structure(part: FakePart): string {
  const [major = "application", minor = "octet-stream"] = part.type.toUpperCase().split("/");
  if (part.children !== undefined && part.children.length > 0) {
    return `(${part.children.map(structure).join("")} ${quote(minor)} ("BOUNDARY" "b-${minor.toLowerCase()}") NIL NIL NIL)`;
  }
  const params: string[] = [];
  if (part.charset !== undefined) params.push(`"CHARSET" ${quote(part.charset)}`);
  if (part.filename !== undefined && part.disposition === undefined)
    params.push(`"NAME" ${quote(part.filename)}`);
  const bytes = bodyBytes(part);
  const disposition =
    part.disposition === undefined
      ? "NIL"
      : `(${quote(part.disposition.toUpperCase())} ${
          part.filename === undefined ? "NIL" : `("FILENAME" ${quote(part.filename)})`
        })`;
  const basic = `${quote(major)} ${quote(minor)} ${params.length === 0 ? "NIL" : `(${params.join(" ")})`} NIL NIL ${quote((part.encoding ?? "7bit").toUpperCase())} ${bytes.length}`;
  const lines = major === "TEXT" ? ` ${bytes.toString("latin1").split("\n").length}` : "";
  return `(${basic}${lines} NIL ${disposition} NIL NIL)`;
}

function sectionOf(message: FakeMessage, section: string): Buffer | undefined {
  let part: FakePart | undefined = message.body;
  const path = section.split(".").map(Number);
  if (part.children === undefined || part.children.length === 0) {
    return section === "1" || section === "TEXT" ? bodyBytes(part) : undefined;
  }
  for (const index of path) {
    part = part?.children?.[index - 1];
    if (part === undefined) return undefined;
  }
  return part.children === undefined ? bodyBytes(part) : undefined;
}

function tokenize(input: string): Token[] {
  let index = 0;
  const readList = (end: string | undefined): Token[] => {
    const tokens: Token[] = [];
    while (index < input.length) {
      const char = input[index];
      if (char === " ") {
        index += 1;
        continue;
      }
      if (char === end) {
        index += 1;
        return tokens;
      }
      if (char === "(") {
        index += 1;
        tokens.push({ list: readList(")") });
        continue;
      }
      if (char === '"') {
        index += 1;
        let value = "";
        while (index < input.length && input[index] !== '"') {
          if (input[index] === "\\") index += 1;
          value += input[index];
          index += 1;
        }
        index += 1;
        tokens.push({ string: value });
        continue;
      }
      if (char === "\u0000") {
        // A literal the reader inlined: NUL, length, NUL, bytes.
        const close = input.indexOf("\u0000", index + 1);
        const length = Number(input.slice(index + 1, close));
        tokens.push({ string: input.slice(close + 1, close + 1 + length) });
        index = close + 1 + length;
        continue;
      }
      let atom = "";
      let depth = 0;
      while (index < input.length) {
        const next = input[index] ?? "";
        if (next === "[") depth += 1;
        if (next === "]") depth -= 1;
        if (depth === 0 && (next === " " || next === ")" || next === "(")) break;
        atom += next;
        index += 1;
      }
      tokens.push({ atom });
    }
    return tokens;
  };
  return readList(undefined);
}

const valueOf = (token: Token | undefined): string =>
  token === undefined ? "" : "atom" in token ? token.atom : "string" in token ? token.string : "";

function inSet(set: string, uid: number, max: number): boolean {
  return set.split(",").some((range) => {
    const [from = "", to] = range.split(":");
    const low = from === "*" ? max : Number(from);
    const high = to === undefined ? low : to === "*" ? max : Number(to);
    return uid >= Math.min(low, high) && uid <= Math.max(low, high);
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function imapDate(value: string): number {
  const [day = "", month = "", year = ""] = value.split("-");
  return Date.UTC(Number(year), MONTHS.indexOf(month.toLowerCase()), Number(day));
}

function internalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const month = MONTHS[date.getUTCMonth()] ?? "jan";
  return `${pad(date.getUTCDate())}-${month[0]?.toUpperCase()}${month.slice(1)}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

const addressText = (list: FakeAddress[] | undefined) =>
  (list ?? []).map((entry) => `${entry.name ?? ""} ${entry.mailbox}@${entry.host}`).join(" ");

function textOf(part: FakePart): string {
  return [bodyBytes(part).toString("utf8"), ...(part.children ?? []).map(textOf)].join(" ");
}

function matches(message: FakeMessage, criteria: Token[], max: number): boolean | "bad" {
  for (let index = 0; index < criteria.length; index++) {
    const key = valueOf(criteria[index]).toUpperCase();
    const next = () => valueOf(criteria[++index]);
    const contains = (haystack: string) => haystack.toLowerCase().includes(next().toLowerCase());
    const day =
      message.date === undefined
        ? 0
        : Date.UTC(
            message.date.getUTCFullYear(),
            message.date.getUTCMonth(),
            message.date.getUTCDate()
          );
    switch (key) {
      case "ALL":
        break;
      case "CHARSET":
        next();
        break;
      case "UID":
        if (!inSet(next(), message.uid, max)) return false;
        break;
      case "FROM":
        if (!contains(addressText(message.from))) return false;
        break;
      case "SUBJECT":
        if (!contains(message.subject ?? "")) return false;
        break;
      case "TEXT":
        if (
          !contains(`${message.subject ?? ""} ${addressText(message.from)} ${textOf(message.body)}`)
        )
          return false;
        break;
      case "SINCE":
        if (day < imapDate(next())) return false;
        break;
      case "BEFORE":
        if (day >= imapDate(next())) return false;
        break;
      default:
        return "bad";
    }
  }
  return true;
}

function portOf(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") throw new Error("No TCP address");
  return address.port;
}

export async function startImapTestServer(options: ImapTestServerOptions): Promise<ImapTestServer> {
  const commands: ImapCommand[] = [];
  const serverNames: (string | false)[] = [];
  const flags = new Map<string, Set<string>>();
  const folders = options.folders;
  let accepted = 0;
  const sockets = new Set<Socket>();
  const flagSet = (folder: string, message: FakeMessage) => {
    const key = `${folder}\u0000${message.uid}`;
    let set = flags.get(key);
    if (set === undefined) {
      set = new Set(message.flags ?? []);
      flags.set(key, set);
    }
    return set;
  };

  const session = (socket: Socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if ("servername" in socket)
      serverNames.push(typeof socket.servername === "string" ? socket.servername : false);
    let authenticated = false;
    let opened: string | undefined;
    let buffer = Buffer.alloc(0);
    let pending = "";
    let literal: number | undefined;
    const send = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    const capabilities = ["IMAP4rev1", ...(options.capabilities ?? [])].join(" ");
    send(`* OK [CAPABILITY ${capabilities}] test server ready`);

    const run = (line: string) => {
      const space = line.indexOf(" ");
      const tag = line.slice(0, space);
      let rest = line.slice(space + 1);
      let name = rest.split(" ", 1)[0]?.toUpperCase() ?? "";
      rest = rest.slice(name.length + 1);
      if (name === "UID") {
        const inner = rest.split(" ", 1)[0]?.toUpperCase() ?? "";
        name = `UID ${inner}`;
        rest = rest.slice(inner.length + 1);
      }
      commands.push({ name, args: rest.replace(/\u0000\d+\u0000/gu, "") });
      const args = tokenize(rest);
      const ok = (text = `${name} completed`) => send(`${tag} OK ${text}`);
      switch (name) {
        case "CAPABILITY":
          send(`* CAPABILITY ${capabilities}`);
          return ok();
        case "NOOP":
          return ok();
        case "ID":
          send("* ID NIL");
          return ok();
        case "LOGIN": {
          const [user, pass] = args.map(valueOf);
          if (user === options.account.username && pass === options.account.password) {
            authenticated = true;
            return ok("[CAPABILITY IMAP4rev1] logged in");
          }
          return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
        case "LOGOUT":
          send("* BYE logging out");
          ok();
          socket.end();
          return;
        case "LIST":
          return ok();
      }
      if (!authenticated) return send(`${tag} BAD not authenticated`);
      if (name === "EXAMINE" || name === "SELECT") {
        const folderName = valueOf(args[0]);
        const folder = folders[folderName];
        if (folder === undefined) return send(`${tag} NO [NONEXISTENT] no such folder`);
        opened = folderName;
        const max = Math.max(0, ...folder.messages.map((message) => message.uid));
        send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
        send(`* ${folder.messages.length} EXISTS`);
        send("* 0 RECENT");
        send(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`);
        send(`* OK [UIDNEXT ${max + 1}] next UID`);
        return ok(`[${name === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${name} completed`);
      }
      const folder = opened === undefined ? undefined : folders[opened];
      if (folder === undefined || opened === undefined) return send(`${tag} BAD no folder open`);
      const max = Math.max(0, ...folder.messages.map((message) => message.uid));
      if (name === "UID SEARCH") {
        const found: number[] = [];
        for (const message of folder.messages) {
          const result = matches(message, args, max);
          if (result === "bad") return send(`${tag} BAD unknown search key`);
          if (result) found.push(message.uid);
        }
        send(`* SEARCH${found.map((uid) => ` ${uid}`).join("")}`);
        return ok();
      }
      if (name === "UID FETCH") {
        const set = valueOf(args[0]);
        const itemToken = args[1];
        const items =
          itemToken !== undefined && "list" in itemToken
            ? itemToken.list.map(valueOf)
            : [valueOf(itemToken)];
        folder.messages.forEach((message, position) => {
          if (!inSet(set, message.uid, max)) return;
          const own = flagSet(opened ?? "", message);
          const parts: string[] = [`UID ${message.uid}`];
          for (const item of items) {
            const upper = item.toUpperCase();
            if (upper === "UID") continue;
            if (upper === "FLAGS") parts.push(`FLAGS (${[...own].join(" ")})`);
            else if (upper === "RFC822.SIZE")
              parts.push(`RFC822.SIZE ${2_000 + bodyBytes(message.body).length}`);
            else if (upper === "INTERNALDATE")
              parts.push(`INTERNALDATE "${internalDate(message.date ?? new Date(0))}"`);
            else if (upper === "ENVELOPE")
              parts.push(
                `ENVELOPE (${quote(message.date?.toUTCString())} ${quote(message.subject)} ${addresses(message.from)} ${addresses(message.from)} ${addresses(message.replyTo ?? message.from)} ${addresses(message.to)} ${addresses(message.cc)} NIL ${quote(message.inReplyTo)} ${quote(message.messageId)})`
              );
            else if (upper === "BODYSTRUCTURE")
              parts.push(`BODYSTRUCTURE ${structure(message.body)}`);
            else {
              const body = /^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/u.exec(upper);
              if (body === null) continue;
              const [, peek, section = "", start, length] = body;
              if (peek === undefined) own.add("\\Seen");
              const whole = sectionOf(message, section) ?? Buffer.alloc(0);
              const from = start === undefined ? 0 : Number(start);
              const bytes = whole.subarray(
                from,
                length === undefined ? undefined : from + Number(length)
              );
              parts.push(
                `BODY[${section}]${start === undefined ? "" : `<${from}>`} {${bytes.length}}\r\n${bytes.toString("latin1")}`
              );
            }
          }
          socket.write(Buffer.from(`* ${position + 1} FETCH (${parts.join(" ")})\r\n`, "latin1"));
        });
        return ok();
      }
      if (name === "STORE" || name === "UID STORE") {
        for (const message of folder.messages) flagSet(opened, message).add("\\Seen");
        return ok();
      }
      return send(`${tag} BAD unknown command`);
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literal !== undefined) {
          if (buffer.length < literal) return;
          const bytes = buffer.subarray(0, literal).toString("utf8");
          pending += `\u0000${bytes.length}\u0000${bytes}`;
          buffer = buffer.subarray(literal);
          literal = undefined;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        const announced = /\{(\d+)(\+?)\}$/u.exec(line);
        if (announced !== null) {
          pending += line.slice(0, announced.index);
          literal = Number(announced[1]);
          if (announced[2] !== "+") send("+ go ahead");
          continue;
        }
        const whole = pending + line;
        pending = "";
        run(whole);
      }
    });
  };

  const server: Server =
    options.tls === false
      ? createTcpServer(session)
      : createTlsServer({ key: options.tls.key, cert: options.tls.certificate }, session);
  if (options.tls !== false) server.on("tlsClientError", () => undefined);
  let tcp = 0;
  server.on("connection", () => {
    tcp += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: portOf(server.address()),
    commands,
    connections: () => Math.max(tcp, accepted),
    serverNames,
    folders,
    flagsOf(folder, uid) {
      const message = folders[folder]?.messages.find((entry) => entry.uid === uid);
      return message === undefined ? [] : [...flagSet(folder, message)].sort();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}
