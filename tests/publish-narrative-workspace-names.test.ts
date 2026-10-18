import { describe, expect, it } from "vitest";
import {
  asCollaborationWorkspaceId,
  asUserId,
  type CollaborationWorkspace,
  type LocaleCode,
  type PublishNarrativeStoredData
} from "@work-shape/catalyst-core";
import { createPublishNarrator } from "@work-shape/catalyst-server";
import { clientInstanceId, everything } from "./support/publish-narrative";

// ACCEPT-FIX-2 C5 on the server: the publish sentence names a Personal Workspace as the
// interface does, after its owner ("Mara's workspace", "Maras Arbeitsbereich", "Felix'
// Arbeitsbereich"), or by the generic name in the reader's language where no name of the owner
// can be read. The name stored on its row, "Personal workspace", is never written: not in the
// sentence an App opens with, not in who uses an App, not in the App's stored-data reader sentence.

const STORED = "Personal workspace";
const MARA = asCollaborationWorkspaceId("cw_mara");
const FELIX = asCollaborationWorkspaceId("cw_felix");
const MAILBOX = asCollaborationWorkspaceId("cw_mailbox");

const WORKSPACES: Record<
  string,
  Pick<CollaborationWorkspace, "name" | "kind" | "personalUserId">
> = {
  [MARA]: { name: STORED, kind: "personal", personalUserId: asUserId("usr_mara") },
  [FELIX]: { name: STORED, kind: "personal", personalUserId: asUserId("usr_felix") },
  // An account without a name has its e-mail address as its label.
  [MAILBOX]: { name: STORED, kind: "personal", personalUserId: asUserId("usr_mailbox") }
};
const PEOPLE: Record<string, string> = {
  usr_mara: "Mara Lindqvist",
  usr_felix: "Felix Pahlke",
  usr_mailbox: "inbox@example.test"
};

function narrator(storedData?: PublishNarrativeStoredData) {
  return createPublishNarrator({
    clientInstanceId,
    stores: {
      configAssets: { getConfigAsset: () => Promise.resolve(undefined) },
      workspaces: { getWorkspace: (_instance, id) => Promise.resolve(WORKSPACES[id]) },
      users: {
        getUser: ({ userId }) => {
          const displayLabel = PEOPLE[userId];
          return Promise.resolve(displayLabel === undefined ? undefined : { displayLabel });
        }
      }
    },
    resolve: () => Promise.resolve(undefined),
    ...(storedData ? { storedData } : {})
  });
}

const app = { title: "Urlaubsanträge", manifest: { actions: [] } };

async function appSentence(
  workspaceId: CollaborationWorkspace["id"],
  locale: LocaleCode,
  storedData?: PublishNarrativeStoredData
): Promise<string> {
  const narrative = await narrator(storedData).narrate({
    kind: "app",
    name: "urlaub",
    scope: { kind: "workspace", workspaceId },
    revision: 1,
    config: app,
    locale,
    access: everything
  });
  if (!narrative) throw new Error("An App revision is narrated");
  return narrative.summary;
}

describe("the publish sentence of an App in a Personal Workspace", () => {
  it("names the workspace after its owner where no audience was chosen", async () => {
    expect(await appSentence(MARA, "en")).toBe(
      "Urlaubsanträge opens for whoever may use it in “Mara's workspace”. It changes nothing."
    );
    expect(await appSentence(MARA, "de")).toContain("„Maras Arbeitsbereich“");
    expect(await appSentence(FELIX, "de")).toContain("„Felix' Arbeitsbereich“");
  });

  it("uses the generic name in the reader's language where the owner has no name", async () => {
    expect(await appSentence(MAILBOX, "de")).toContain("„Persönlicher Arbeitsbereich“");
    expect(await appSentence(MAILBOX, "de")).not.toContain(STORED);
    expect(await appSentence(MAILBOX, "en")).toContain("“Personal workspace”");
  });

  it("names the people who use it by the owner's workspace, not the stored name", async () => {
    const stored: PublishNarrativeStoredData = {
      // The stored-data module reads the name stored on the row.
      appRevision: () =>
        Promise.resolve({
          audience: { workspace: { title: STORED, members: 1 }, holders: 0 },
          stores: [],
          truncated: false
        }),
      storeReaders: () => Promise.resolve([])
    };
    const english = await appSentence(MARA, "en", stored);
    expect(english).toContain("“Mara's workspace”");
    expect(english).not.toContain(STORED);
    const german = await appSentence(MARA, "de", stored);
    expect(german).toContain("„Maras Arbeitsbereich“");
    expect(german).not.toContain(STORED);
  });
});
