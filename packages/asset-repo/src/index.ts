// What the worker needs of the command that keeps repositories: its names, limits and the
// shapes of a request and a result. Nothing here starts git; that is `cli.ts`, which runs in
// the sandbox only.
export { assetRepoCommandFile } from "./command-file";
export {
  ASSET_REPO_BUNDLES_DIRECTORY,
  ASSET_REPO_COMMAND,
  ASSET_REPO_DRAFT_REF,
  ASSET_REPO_FOLDER_DIRECTORY,
  ASSET_REPO_MAX_BUNDLE_BYTES,
  ASSET_REPO_MAX_FILE_BYTES,
  ASSET_REPO_MAX_FILES,
  ASSET_REPO_MAX_PATH_BYTES,
  ASSET_REPO_MAX_TREE_BYTES,
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REPOSITORY_DIRECTORY,
  ASSET_REPO_REQUEST_FILE,
  ASSET_REPO_RESULT_FILE,
  ASSET_REPO_REVISION_REF_PREFIX
} from "./limits";
export type {
  AssetRepoRefusal,
  BundleReference,
  CommitFolderRequest,
  CommitFolderResult,
  MaterialiseRequest,
  MaterialiseResult
} from "./request";
export { pathRefusal, treeRefusal, type TreeEntry, type TreeRefusal } from "./tree-check";
