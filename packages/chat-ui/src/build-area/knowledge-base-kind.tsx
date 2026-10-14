import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { KnowledgeBaseEditor } from "./knowledge-base-editor";
import { knowledgeBaseConfigToForm, startedKnowledgeBaseForm } from "./knowledge-base-model";
import { useKnowledgeBaseSource, type KnowledgeBaseSource } from "./knowledge-base-source";

/** The kind's segment in an address: `/build/knowledge-bases`. */
const KNOWLEDGE_BASES_BUILD_PATH = "knowledge-bases";

/**
 * Knowledge Bases in Build on the answers of `useSource`: a list, and a page that writes a
 * draft of one and publishes it. A row says what the Knowledge Base holds.
 */
export function knowledgeBaseKindOn(useSource: () => KnowledgeBaseSource): BuildAssetKind {
  function KnowledgeBaseAssetEditor(frame: BuildAssetEditorProps) {
    const { asset, start } = frame;
    return (
      <KnowledgeBaseEditor
        frame={frame}
        initialForm={
          asset
            ? knowledgeBaseConfigToForm(asset.config)
            : startedKnowledgeBaseForm(start ?? { name: "", title: "" })
        }
        source={useSource()}
      />
    );
  }
  return {
    kind: "knowledge_base",
    path: KNOWLEDGE_BASES_BUILD_PATH,
    label: "knowledge.kind",
    description: "knowledge.description",
    searchLabel: "knowledge.search",
    newLabel: "knowledge.new",
    titleLabel: "knowledge.titleLabel",
    deleteTitle: "knowledge.deleteTitle",
    deleteDescription: "knowledge.deleteDescription",
    emptyText: "knowledge.empty",
    emptyReadOnlyText: "knowledge.emptyReadOnly",
    missingText: "knowledge.missing",
    icon: "knowledge_base",
    rowText: (asset) => asset.description,
    Editor: KnowledgeBaseAssetEditor
  };
}

/** Knowledge Bases in Build on the instance's own answers. */
export const knowledgeBaseKind = knowledgeBaseKindOn(useKnowledgeBaseSource);
