import type { ComponentType, ReactNode, Ref } from "react";
import type { Asset, AssetSummary } from "@work-shape/catalyst-api-client";
import type { AvatarKind, GenericIconKey, PageHeaderProps } from "@work-shape/catalyst-ui";
import type {
  AssetFileEntry,
  AssetFileRead,
  AssetFileWrite,
  AvailableIn,
  CheckName
} from "../../shared/api/asset-writes";
import type { TranslationKey } from "../../shared/i18n";
import type { BuildWriteOutcome } from "./build-refusals";
import type { BuildWithAgentCopy } from "../build-with-agent-empty";
import type { BuildNamespace, BuildScope } from "../../shared/build-rights";

/** What a page puts at the end of its head: Publish, History and the "…" menu with Delete. */
export type BuildHeadActions = Pick<PageHeaderProps, "primaryAction" | "secondaryActions" | "menu">;

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
  /** What the asset does, in the reader's language, where its kind's dialog asks. */
  description?: string;
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
  actions: BuildHeadActions;
  /**
   * What the frame says beside the name of an asset whose kind has a draft and a published
   * revision: that the saved draft is ahead of what is published, or that nothing is.
   */
  draftState?: ReactNode;
  /** What the frame says above the save bar: a conflict with the way to the newer version. */
  notice: ReactNode;
  /** Hears whether the page holds changes that are not saved: the frame asks before it is left. */
  onUnsavedChange(unsaved: boolean): void;
  /**
   * Saves the definition against the revision the page loaded, or creates the asset. A save of
   * an existing agent names the draft revision the page read, or `null` where it read none: it
   * writes the agent's draft, answers the draft revision it wrote and leaves the live agent and
   * the revision the page loaded as they are.
   */
  save(
    config: Record<string, unknown>,
    draft?: { expectedDraftRevision: number | null }
  ): Promise<BuildWriteOutcome & { draftRevision?: number }>;
  /** The reader may publish the asset: for an agent, its draft. */
  canPublish?: boolean;
  /**
   * Hears which draft revision of the agent the page shows, or that it shows none: a restore
   * from the History names it.
   */
  onDraftRead?(revision: number | null): void;
  /**
   * Reads the asset again after a change the page did not write itself, such as an applied
   * proposal: the page starts again from what the instance holds. Absent for a new asset.
   */
  reload?(): Promise<unknown>;
  /**
   * The folder of a kind whose revision holds files beside its config, such as a skill: reads
   * the files of the revision the page loaded, and saves the whole folder against it, or
   * creates the asset with it. Absent where the frame writes the config alone.
   */
  folder?: {
    read(): Promise<AssetFileRead[]>;
    /** A save that was made answers the files it stored, each with its hash. */
    save(
      files: readonly AssetFileWrite[]
    ): Promise<BuildWriteOutcome & { stored?: readonly AssetFileEntry[] }>;
  };
}

/**
 * What the frame hands a kind's own dialog for a new asset, in place of the one that asks for
 * the name and the id: the Namespaces the reader may name it in, and the writes of the asset.
 */
export interface BuildCreateDialogProps {
  namespaces: readonly BuildNamespace[];
  /** The reader may name the asset without a Namespace. */
  mayNameFreely: boolean;
  /** Asks the instance whether the asset could take the name, as it is typed. */
  checkName: CheckName;
  /** Writes the asset's definition: creates it at `null`, else over the revision given. */
  put(input: {
    name: string;
    config: Record<string, unknown>;
    expectedRevision: number | null;
  }): Promise<{ revision: number }>;
  /** Deletes the asset the dialog made, where the reader may (`mayDelete`). */
  remove(input: { name: string; expectedRevision: number }): Promise<unknown>;
  /** Whether the reader may delete an asset of the kind in this Namespace, by its prefix. */
  mayDelete(namespace: string | undefined): boolean;
  onClose(): void;
  /**
   * The asset exists: the frame closes the dialog and opens its page. `then` runs once the
   * page is open, such as opening the chat beside it.
   */
  onCreated(name: string, then?: () => void): void;
}

/** What the reader narrows a list by, as its leading rows are handed it. */
export interface BuildListLeadFilter {
  /** What the reader typed, once they paused. */
  text: string;
  namespace: string | undefined;
  /** The scope the list shows, for a kind that is listed per scope. */
  scope: BuildScope | undefined;
}

/** One row a kind adds before the assets of its list. It looks as theirs do and opens nothing. */
export interface BuildListLeadRow {
  key: string;
  title: string;
  /** The lines under the title, read whole. */
  description: ReactNode;
  /** After the title, as an asset's scope and badges are. */
  chips?: ReactNode;
  /** Always shown at the row's end, such as a switch. */
  actions?: ReactNode;
}

/** The rows a kind adds before the assets of its list. */
export interface BuildListLead {
  /** Absent while they are read. */
  rows: readonly BuildListLeadRow[] | undefined;
  /** What went wrong reading or changing them, shown where a list error is. */
  error?: ReactNode;
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
  /**
   * What the empty list offers a person whose New opens the agent: the agent with two examples
   * (UXA-3b). Everybody else reads `emptyText`, which then says what the kind is.
   */
  emptyBuild?: BuildWithAgentCopy;
  /** The kind's key in the icon registry: one icon per kind, the same everywhere. */
  icon: GenericIconKey;
  /** Rows show an avatar with the name's initials. Without it they show the kind's icon. */
  avatar?: AvatarKind;
  /**
   * What a row says of an asset where the kind tells more than its icon: its own mark, where it
   * has one, and the line under the title. A row without a line shows the title alone. No row
   * shows the asset's id.
   */
  row?(asset: BuildAssetRow): { leading?: ReactNode; description?: string };
  /** The line under a row's title: what the asset does, such as its description. */
  rowText?(asset: BuildAssetRow): string | undefined;
  /**
   * The line under a row's title in the kind's own words, in place of `rowText`, shown whole:
   * a component, so it may read what the page knows, such as workspace names.
   */
  RowLine?: ComponentType<{ asset: BuildAssetRow }>;
  /**
   * Rows the list shows before the assets', in the same list under its search and filters:
   * such as the guardrails the release ships, which are no asset of the list. It is handed what
   * the reader narrows the list by and hands the list the rows that match.
   */
  ListLead?: ComponentType<{
    filter: BuildListLeadFilter;
    children(lead: BuildListLead): ReactNode;
  }>;
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
  /** The dialog's question of what the new asset does. A kind without it asks the name alone. */
  purposeLabel?: TranslationKey;
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
   * The kind's own dialog for a new asset, which makes the asset itself. Without it the frame
   * asks for the name and the id and opens the `Editor` of a new asset. A copy always takes
   * the frame's dialog.
   */
  CreateDialog?: ComponentType<BuildCreateDialogProps>;
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
  /**
   * Publishes the draft the page shows and reads the asset again: the person's click, never
   * the agent's. Answers the instance's sentence where it refused. Absent where the asset has no
   * draft ahead of what is published, or the reader may not publish it.
   */
  publish?(): Promise<string | undefined>;
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
