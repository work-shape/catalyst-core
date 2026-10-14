import type { ComponentType, ReactNode, Ref } from "react";
import type { Asset, AssetSummary } from "@vivd-catalyst/api-client";
import type { AvatarKind, GenericIconKey } from "@vivd-catalyst/ui";
import type { AvailableIn } from "../api/asset-writes";
import type { TranslationKey } from "../i18n";
import type { BuildWriteOutcome } from "./build-refusals";

/** One asset as a list shows it: what the instance says of it without its content. */
export type BuildAssetRow = AssetSummary;

/** One asset as its page loaded it. The page writes against this revision and no later one. */
export type BuildAsset = Asset;

/** What the reader chose in the dialog that starts a new asset. */
export interface BuildAssetStart {
  /** The id, with the prefix of its Namespace. */
  name: string;
  /** The name people read. */
  title: string;
  /** Where a new asset of a kind that `startsInWorkspace` starts available. */
  availableIn?: AvailableIn;
  /** The definition a copy starts from. A new asset without it starts empty. */
  copyOf?: Record<string, unknown>;
}

/** Where an asset page stands in the frame. The page's body hands it to its `Page`. */
export interface BuildPageSlot {
  ref: Ref<HTMLDivElement>;
  /** What the frame says above every page, such as that Build could not be loaded. */
  above: ReactNode;
  /** The page shows something new: the frame moves the focus to its heading. */
  shown(): void;
}

/** What the frame hands the body of an asset page. */
export interface BuildAssetEditorProps {
  page: BuildPageSlot;
  /** The open asset, as loaded. Absent while a new one is written. */
  asset: BuildAsset | undefined;
  /** The name and the id of a new asset. Present exactly when `asset` is absent. */
  start: BuildAssetStart | undefined;
  /** The reader may change the asset. Without it the page is read-only. */
  canWrite: boolean;
  /** Why the reader may not change the asset, for the notice of a read-only page. */
  readOnlyReason?: string;
  /** Saving waits for the reader's answer to a notice, such as a conflict. */
  saveBlocked?: boolean;
  /** The reader may change what belongs to the instance: its default and where an agent shows. */
  instanceWrite: boolean;
  /**
   * The workspace that owns the asset, or that a new one is made for, by its id. Absent for
   * the instance's own. What the asset may name is read from it and from the instance.
   */
  owner?: string;
  /** The way back to the kind's list, for the start of the page head. */
  back: ReactNode;
  /** The page's own actions, for the end of the page head: History and the menu with Delete. */
  actions: ReactNode;
  /** What the frame says above the save bar: a conflict with the way to the newer version. */
  notice: ReactNode;
  /** Hears whether the page holds changes that are not saved: the frame asks before it is left. */
  onUnsavedChange(unsaved: boolean): void;
  /** Saves the definition against the revision the page loaded, or creates the asset. */
  save(config: Record<string, unknown>): Promise<BuildWriteOutcome>;
}

/** What every kind of the Build area names: its rail item and its list. */
interface BuildKindBase {
  /** The asset kind, as the server stores it. */
  kind: string;
  /** The kind's segment in an address: `/build/<path>`. */
  path: string;
  /** The kind in the plural: the rail item and the list's title. */
  label: TranslationKey;
  /** Names the list's search field. */
  searchLabel: TranslationKey;
  /** What the list says under its title, with rows and without: such as where the kind comes from. */
  description?: TranslationKey;
  /** The sentence of the empty list. An editable kind says it to a person who may create. */
  emptyText: TranslationKey;
  /** The kind's key in the icon registry: one icon per kind, the same everywhere. */
  icon: GenericIconKey;
  /** Rows show an avatar with the name's initials. Without it they show the kind's icon. */
  avatar?: AvatarKind;
  /**
   * What a row says of an asset where the kind tells more than its icon and the asset's id: its
   * own mark, where it has one, and the line under the title. A row without a line shows the
   * title alone.
   */
  row?(asset: BuildAssetRow): { leading?: ReactNode; description?: string };
  /** What a row says after the asset's id, on the same line: such as the asset's description. */
  rowText?(asset: BuildAssetRow): string | undefined;
  /** The row's badges, such as the default marker. */
  badges?(asset: BuildAssetRow, t: (key: TranslationKey) => string): ReactNode;
}

/**
 * What the client knows about one kind of Build asset. The frame (the routes, the kind rail,
 * the list with search and pages, the dialog that starts an asset, the page's way back, its
 * History, the delete, the conflict answer and every state) is the same for every kind; a
 * slice that adds a kind adds a file of its own and one entry to `buildAssetKinds`. Whether a
 * kind is on, who may read or create it and what it holds come from the instance.
 */
export interface BuildAssetKind extends BuildKindBase {
  /** The one button that starts a new asset, and the title of its dialog. */
  newLabel: TranslationKey;
  /** Names the field of the dialog that asks for the name people read. */
  titleLabel: TranslationKey;
  /** The question that confirms a delete, with `{name}`, and the sentence under it. */
  deleteTitle: TranslationKey;
  deleteDescription: TranslationKey;
  /** The sentence of the empty list for a person who may not create. */
  emptyReadOnlyText: TranslationKey;
  /** The sentence shown at the address of an asset that does not exist. */
  missingText: TranslationKey;
  /** The body of the asset page, for an existing asset and for a new one. */
  Editor: ComponentType<BuildAssetEditorProps>;
  /**
   * A new asset is available in the shared workspace it is made in: the dialog that starts
   * it says where, and offers every workspace to whoever may change that.
   */
  startsInWorkspace?: true;
  /**
   * The name people read of an asset that ships with the platform, and nothing for one of the
   * instance's own. Nobody changes or deletes a shipped asset here, because a release replaces
   * it: a person who may create one of the kind copies it and edits the copy.
   */
  shippedTitle?(asset: BuildAsset): string | undefined;
  /** The CLI does not write the kind yet, so its list offers no CLI entry. */
  withoutCli?: true;
}

/** What the frame hands a page that shows one asset and changes nothing of it. */
export interface BuildAssetViewProps {
  page: BuildPageSlot;
  /** The way back to the kind's list, for the start of the page head. */
  back: ReactNode;
  /** The open asset, as loaded. */
  asset: BuildAsset;
  /** The kinds the reader sees in Build, for a page that names an asset of another kind. */
  kinds: readonly BuildKind[];
}

/**
 * A kind the interface lists and does not edit: it has a rail item and a list, and no button
 * that starts an asset and no CLI entry. Without `view` its rows are not links.
 */
export interface BuildListedKind extends BuildKindBase {
  Editor?: undefined;
  /**
   * A page that shows one asset of the kind and writes nothing: no History, no delete, no save.
   * With it the rows open, and `missingText` is the sentence at the address of an asset that
   * does not exist, with `{name}`.
   */
  view?: { Page: ComponentType<BuildAssetViewProps>; missingText: TranslationKey };
}

/** One kind of the Build area. */
export type BuildKind = BuildAssetKind | BuildListedKind;

/** The kind has an asset page that edits: its rows open and a new asset can be started. */
export function isEditableKind(kind: BuildKind): kind is BuildAssetKind {
  return kind.Editor !== undefined;
}

/** An asset of the kind has an address of its own: a page that edits it or one that shows it. */
export function opensAssets(kind: BuildKind): boolean {
  return isEditableKind(kind) || kind.view !== undefined;
}
