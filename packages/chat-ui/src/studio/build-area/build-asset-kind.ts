// What the client knows about the kinds of Build asset and what the frame hands their pages,
// one file per part under `build-kind/`, so that features that change different parts of the
// frame change different files.

export type { BuildAsset, BuildAssetRow, BuildHeadActions } from "./build-kind/asset";
export type {
  BuildCreateDialogProps,
  BuildImportDialogProps
} from "./build-kind/create-dialog-props";
export type {
  BuildAssetEditorProps,
  BuildAssetStart,
  BuildPageSlot
} from "./build-kind/editor-props";
export {
  isEditableKind,
  opensAssets,
  type BuildAssetKind,
  type BuildAssetViewProps,
  type BuildKind,
  type BuildListedKind
} from "./build-kind/kind";
export type { BuildListLead, BuildListLeadFilter, BuildListLeadRow } from "./build-kind/list-lead";
