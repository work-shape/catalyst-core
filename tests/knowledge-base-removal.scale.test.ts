import { describe } from "vitest";
import { registerKnowledgeRemovalVolumeTest } from "./support/knowledge-removal-volume";

describe("Knowledge Base removal at customer volume", () => {
  registerKnowledgeRemovalVolumeTest({ documents: 2000, contents: 1000, interruptAt: 650 });
});
