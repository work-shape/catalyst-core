import type { ConnectorTypeDefinition } from "@work-shape/catalyst-client-assembly";
import { DocumentSourceError } from "@work-shape/catalyst-core";
import { z } from "zod";

// A document source of the browser suite, with a form of its own: the New connection dialog
// offers it beside an MCP server and a REST API. It reaches nothing. Its folders are fixed
// here, and the secret `refused-secret` is refused by its test, as a wrong one would be.

const settings = z
  .object({
    accountId: z.string().min(1),
    region: z.literal("eu"),
    testFolderId: z.string().min(1).default("100")
  })
  .strict();

const REFUSED_SECRET = "refused-secret";

/** The folders by id, and the text of each item in them. */
const FOLDERS: Record<string, { id: string; name: string; text: string }[]> = {
  "100": [
    { id: "item-handbook", name: "handbook.txt", text: "The handbook of the folder source." }
  ],
  "200": [{ id: "item-other", name: "other.txt", text: "Outside the folder of the handbook." }]
};

const MODIFIED_AT = "2026-10-01T08:00:00.000Z";

export const folderSourceConnector: ConnectorTypeDefinition = {
  type: "test_folders",
  description: "Fixed folders of the browser suite. It reaches nothing.",
  settingsSchema: settings,
  authSchemes: ["client_credentials"],
  secretFields: ["clientSecret"],
  catalog: [],
  // The suite's `egress.allow` permits it; nothing is sent.
  target: () => ({ protocol: "https", host: "127.0.0.1", port: 8443 }),
  limits: { callTimeoutMs: 5_000, resultMaxBytes: 16 * 1024, maxParallelCalls: 4 },
  form: {
    title: { en: "Test folders", de: "Testordner" },
    description: {
      en: "Fixed folders of the browser suite.",
      de: "Feste Ordner der Browser-Tests."
    },
    service: "Test folders",
    authScheme: "client_credentials",
    settings: { region: "eu" },
    fields: [
      { label: { en: "Account ID", de: "Konto-ID" }, setting: "accountId" },
      {
        label: { en: "Test folder ID", de: "ID des Testordners" },
        help: {
          en: "The connection test reads this folder.",
          de: "Der Verbindungstest liest diesen Ordner."
        },
        setting: "testFolderId",
        optional: true
      },
      { label: { en: "Client secret", de: "Client-Secret" }, secret: true }
    ]
  },
  documentSource: {
    list: ({ boundary }) =>
      Promise.resolve({
        items: boundary.folderIds.flatMap((folderId) =>
          (FOLDERS[folderId] ?? []).map((item) => ({
            id: item.id,
            version: "1",
            path: `/${item.name}`,
            name: item.name,
            mime: "text/plain",
            size: Buffer.byteLength(item.text),
            modifiedAt: MODIFIED_AT,
            parents: [folderId]
          }))
        )
      }),
    changes: () => Promise.resolve({ kind: "not_offered" }),
    async *fetch({ itemId }) {
      const item = Object.values(FOLDERS)
        .flat()
        .find((entry) => entry.id === itemId);
      if (item === undefined) throw new DocumentSourceError("not_found", "The item is gone");
      yield new TextEncoder().encode(item.text);
    }
  },
  test: (context) =>
    Promise.resolve({
      status:
        context.credentialFor(context.target)?.secret === REFUSED_SECRET ? "unauthorized" : "ready"
    }),
  execute: () => Promise.reject(new Error("The folder source has no operations"))
};
