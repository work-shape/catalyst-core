import { describe, expect, it } from "vitest";
import { required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";

// The publish question of a Knowledge Base with a synced source, in the reader's language
// (SRC-2): how many people find everything in which folders, read with which shared account,
// and that their own rights at the source do not apply.

describe("the publish question of a synced source", () => {
  const { setup } = useKnowledgeSync();

  it("names the audience, the folders and the shared account, in German and in English", async () => {
    const world = await setup();
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "sync-test"
      })
    );
    const ask = (locale: "de" | "en") =>
      world.knowledge.publishQuestion({
        assetId: asset.id,
        scope: asset.scope,
        config: asset.publishedConfig,
        locale
      });
    const german = (await ask("de")).join("\n");
    expect(german).toMatch(
      /\d+ (Person|Personen) mit Zugriff auf „Source“ (findet|finden) alles in den Ordnern folder, other, gelesen mit dem gemeinsamen Konto fixture\. Die eigenen Rechte dieser Personen in der Quelle gelten hier nicht\./u
    );
    const english = (await ask("en")).join("\n");
    expect(english).toMatch(
      /\d+ (person|people) with access to “Source” can find everything in folders folder, other, read with the shared account fixture\. Their own rights at the source do not apply\./u
    );
  });
});
