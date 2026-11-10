import {
  connectionCallError,
  type ConnectorContext,
  type ConnectorTypeDefinition,
  type JsonValue
} from "@work-shape/catalyst-core";
import { openMailboxSession, type MailboxSession } from "./mailbox";
import {
  getInputSchema,
  getMessage,
  IMAP_OPERATIONS,
  readMessageId,
  readSearchInput,
  searchInputSchema,
  searchMessages
} from "./operations";
import {
  imapCredentialAccount,
  imapSettingsOf,
  imapSettingsSchema,
  imapTarget,
  type ImapSettings
} from "./settings";

/** The id a Connection names as its `connectorType`. */
export const IMAP_CONNECTOR_TYPE = "imap";
/** The deadline of one call: login, EXAMINE, SEARCH and FETCH. */
export const IMAP_CALL_TIMEOUT_MS = 20_000;
/** The largest answer of one call, as JSON. */
export const IMAP_RESULT_MAX_BYTES = 512 * 1024;
/** Sessions one Connection opens side by side. A mail server limits them per account. */
export const IMAP_MAX_PARALLEL_CALLS = 2;

async function withSession<T>(
  context: ConnectorContext,
  settings: ImapSettings,
  work: (session: MailboxSession) => Promise<T>
): Promise<T> {
  const session = await openMailboxSession(context, settings);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

function inputOf<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  input: JsonValue
): T {
  const read = schema.safeParse(input);
  // The input is the model's; the refusal names no value of it.
  if (!read.success) throw connectionCallError("input_invalid");
  return read.data;
}

/**
 * The Connector type `imap`: one functional mailbox, read over IMAP with implicit TLS and the
 * password of the Connection (MBX). It reads the folders its settings list and nothing else,
 * opens them read-only and reads bodies with BODY.PEEK, so no flag of the mailbox changes. What
 * it answers is one person's to read (`privateResults`). Building it opens no connection.
 */
export function createImapConnectorType(): ConnectorTypeDefinition {
  return {
    type: IMAP_CONNECTOR_TYPE,
    description: "A functional mailbox, read over IMAP with implicit TLS. It changes nothing.",
    settingsSchema: imapSettingsSchema,
    authSchemes: ["password"],
    secretFields: ["password"],
    target: imapTarget,
    credentialAccount: imapCredentialAccount,
    privateResults: true,
    catalog: IMAP_OPERATIONS,
    limits: {
      callTimeoutMs: IMAP_CALL_TIMEOUT_MS,
      resultMaxBytes: IMAP_RESULT_MAX_BYTES,
      maxParallelCalls: IMAP_MAX_PARALLEL_CALLS
    },

    // The login and an EXAMINE of every folder: the server is there, takes the password and
    // has each folder. A failure is its reason, which the Connection's health records; what
    // the server answers is not kept.
    async test(context) {
      const settings = imapSettingsOf(context.connection.settings);
      await withSession(context, settings, async (session) => {
        for (const folder of settings.folders) await session.examine(folder);
      });
      return { status: "ready" };
    },

    async execute(operation, input, context) {
      const settings = imapSettingsOf(context.connection.settings);
      if (operation === "search_messages") {
        const read = inputOf(searchInputSchema, input);
        // Folder and cursor are checked before the server is contacted.
        readSearchInput(settings, read);
        return withSession(context, settings, (session) => searchMessages(session, settings, read));
      }
      if (operation === "get_message") {
        const { id } = inputOf(getInputSchema, input);
        readMessageId(settings, id);
        return withSession(context, settings, (session) => getMessage(session, settings, id));
      }
      throw connectionCallError("operation_unknown");
    }
  };
}
