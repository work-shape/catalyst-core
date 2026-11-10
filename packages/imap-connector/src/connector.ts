import {
  connectionCallError,
  type ConnectorContext,
  type ConnectorTypeDefinition,
  type ConnectorTypeForm,
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
  IMAP_FOLDERS_MAX,
  IMAPS_PORT,
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
 * The card "Mailbox (IMAP)" in the New connection dialog and its form: server, user name,
 * password and folders, the port under "Technical details". The password goes through
 * `connections.set_secret` and is never a setting.
 */
const IMAP_FORM: ConnectorTypeForm = {
  title: { en: "Mailbox (IMAP)", de: "Postfach (IMAP)" },
  description: {
    en: "A shared mailbox an agent reads, such as a feedback address. Reading leaves every mail unread.",
    de: "Ein gemeinsames Postfach, das ein Agent liest, etwa eine Feedback-Adresse. Lesen lässt jede Mail ungelesen."
  },
  authScheme: "password",
  fields: [
    {
      label: { en: "Server", de: "Server" },
      help: {
        en: "The IMAP server's host name, such as imap.example.com, without imaps:// or a port.",
        de: "Der Hostname des IMAP-Servers, etwa imap.example.com, ohne imaps:// und ohne Port."
      },
      setting: "host"
    },
    {
      label: { en: "User name", de: "Benutzername" },
      help: {
        en: "Usually the mailbox's address.",
        de: "Meist die Adresse des Postfachs."
      },
      setting: "username"
    },
    {
      label: { en: "Password or app password", de: "Passwort oder App-Passwort" },
      help: {
        en: "Where the mail provider offers app passwords, use one for this mailbox alone.",
        de: "Wo der Mail-Anbieter App-Passwörter anbietet, nimm eines nur für dieses Postfach."
      },
      secret: true
    },
    {
      label: { en: "Folders", de: "Ordner" },
      help: {
        en: `The folders agents may read, separated by commas, at most ${IMAP_FOLDERS_MAX}.`,
        de: `Die Ordner, die Agenten lesen dürfen, mit Kommas getrennt, höchstens ${IMAP_FOLDERS_MAX}.`
      },
      setting: "folders",
      value: "list",
      default: "INBOX"
    },
    {
      label: { en: "Port", de: "Port" },
      help: {
        en: `IMAP over implicit TLS, ${IMAPS_PORT} at almost every provider. Port 143 is refused.`,
        de: `IMAP über TLS von Anfang an, bei fast jedem Anbieter ${IMAPS_PORT}. Port 143 wird abgelehnt.`
      },
      setting: "port",
      value: "number",
      default: String(IMAPS_PORT),
      advanced: true
    }
  ],
  sharedAccountNote: {
    en: "Everyone who may use this connection reads every mail in these folders.",
    de: "Alle, die diese Verbindung nutzen dürfen, lesen jede Mail in diesen Ordnern."
  }
};

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
    form: IMAP_FORM,
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
