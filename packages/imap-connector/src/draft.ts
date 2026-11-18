import { randomUUID } from "node:crypto";

// A draft as the mailbox stores it: one RFC 5322 message with a plain UTF-8 text body, built
// here without a library. Every value that reaches a header was checked before (an address, a
// name or subject without a line break), and every header that holds more than plain ASCII is
// written as RFC 2047 encoded words, so nothing the model wrote can add a header or a part.

export interface DraftAddress {
  name?: string;
  /** `local@domain`, ASCII only. */
  address: string;
}

export interface Draft {
  from?: DraftAddress;
  to: readonly DraftAddress[];
  cc: readonly DraftAddress[];
  subject: string;
  text: string;
  /** The Message-ID of the message the draft answers, with its angle brackets. */
  inReplyTo?: string;
  /** The thread the draft answers, oldest first, each with its angle brackets. */
  references?: readonly string[];
  date: Date;
}

/** A plain address: dot-atom local part, a host name with at least one dot. ASCII only. */
const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const ADDRESS_MAX_CHARS = 254;
const NAME_MAX_CHARS = 200;
/** `Name <address>`, the name optionally in double quotes. */
const NAMED = /^\s*(?:"([^"]*)"|([^<>"]*?))\s*<([^<>\s]+)>\s*$/u;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** One message id as it travels: `<…>` without space or brackets inside. */
const MESSAGE_ID = /<[^<>\s]{1,994}>/gu;
/** How many ids a References header keeps: the first and the latest ones. */
const REFERENCES_MAX = 20;

/** The address of `Name <a@b>` or `a@b`; undefined for anything else. */
export function readAddress(value: string): DraftAddress | undefined {
  const named = NAMED.exec(value);
  const address = (named?.[3] ?? value).trim();
  if (address.length > ADDRESS_MAX_CHARS || !ADDRESS.test(address)) return undefined;
  const name = (named?.[1] ?? named?.[2] ?? "").trim();
  if (name.length > NAME_MAX_CHARS || CONTROLS.test(name)) return undefined;
  return name === "" ? { address } : { name, address };
}

/** The message ids in a header value, at most REFERENCES_MAX: the first and the latest. */
export function messageIdsOf(value: string | undefined): string[] {
  const ids = value?.match(MESSAGE_ID) ?? [];
  if (ids.length <= REFERENCES_MAX) return ids;
  return [ids[0] ?? "", ...ids.slice(ids.length - REFERENCES_MAX + 1)];
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/u;
/** Bytes of UTF-8 in one encoded word: 45 bytes are 60 characters of base64. */
const WORD_BYTES = 45;

/** RFC 2047 encoded words of the text, each at most 75 characters, never splitting a character. */
function encodedWords(value: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "" || words.length === 0) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`);
}

/** A header value of free text: as it is where it is short ASCII, else encoded and folded. */
function textValue(value: string): string {
  if (ASCII_PRINTABLE.test(value) && value.length <= 900 && !/=\?/u.test(value)) return value;
  return encodedWords(value).join("\r\n ");
}

function addressValue({ name, address }: DraftAddress): string {
  if (name === undefined) return address;
  const shown =
    ASCII_PRINTABLE.test(name) && !/=\?/u.test(name)
      ? `"${name.replace(/[\\"]/gu, (char) => `\\${char}`)}"`
      : encodedWords(name).join(" ");
  return `${shown} <${address}>`;
}

function addressesValue(list: readonly DraftAddress[]): string {
  return list.map(addressValue).join(",\r\n ");
}

/** RFC 5322 date in UTC: `Wed, 18 Nov 2026 09:30:00 +0000`. */
function dateValue(date: Date): string {
  return date.toUTCString().replace(/GMT$/u, "+0000");
}

/** Base64 in lines of 76 characters (RFC 2045). */
function base64Lines(bytes: Buffer): string {
  return (bytes.toString("base64").match(/.{1,76}/gu) ?? []).join("\r\n");
}

/** The draft as the bytes that APPEND sends, and the Message-ID it carries. */
export function buildDraft(draft: Draft): { bytes: Buffer; messageId: string } {
  const domain = draft.from?.address.split("@")[1] ?? "draft.invalid";
  const messageId = `<${randomUUID()}@${domain}>`;
  const text = draft.text.replace(/\r\n?/gu, "\n").replace(/\n/gu, "\r\n");
  const headers: [string, string][] = [
    ...(draft.from === undefined ? [] : [["From", addressValue(draft.from)] as [string, string]]),
    ...(draft.to.length === 0 ? [] : [["To", addressesValue(draft.to)] as [string, string]]),
    ...(draft.cc.length === 0 ? [] : [["Cc", addressesValue(draft.cc)] as [string, string]]),
    ["Subject", textValue(draft.subject)],
    ["Date", dateValue(draft.date)],
    ["Message-ID", messageId],
    ...(draft.inReplyTo === undefined
      ? []
      : [["In-Reply-To", draft.inReplyTo] as [string, string]]),
    ...(draft.references === undefined || draft.references.length === 0
      ? []
      : [["References", draft.references.join("\r\n ")] as [string, string]]),
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Transfer-Encoding", "base64"]
  ];
  const head = headers.map(([name, value]) => `${name}: ${value}\r\n`).join("");
  const body = base64Lines(Buffer.from(text, "utf8"));
  return { bytes: Buffer.from(`${head}\r\n${body}\r\n`, "utf8"), messageId };
}
