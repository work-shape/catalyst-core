import type { ComponentType, ReactNode } from "react";
import type { AvatarKind, GenericIconKey } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "../../../shared/i18n";
import type { BuildWithAgentCopy } from "../../build-with-agent-empty";
import type { BuildAsset, BuildAssetRow } from "./asset";
import type { BuildCreateDialogProps } from "./create-dialog-props";
import type { BuildAssetEditorProps, BuildPageSlot } from "./editor-props";
import type { BuildListLead, BuildListLeadFilter } from "./list-lead";

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
  /**
   * The asset's page offers "Edit with the agent" in its head to a reader who may change the
   * asset, where the instance offers an agent that builds assets.
   */
  editsWithAgent?: true;
  /**
   * The publish dialog reads the saved draft's publish question again and lists its lines, as
   * who will find what through a synced source: the question the page loaded may be stale.
   */
  asksBeforePublish?: true;
  /**
   * A new asset of the kind with this definition is published right after its create, where the
   * reader may publish it, such as a Knowledge Base of documents: it starts available nowhere.
   */
  publishesOnCreate?(config: Record<string, unknown>): boolean;
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
  /**
   * Deletes the asset through the frame and leaves its page. Answers the instance's sentence
   * where it refused. Absent where the reader may not delete it.
   */
  remove?(): Promise<string | undefined>;
  /** "Edit with the agent" for the end of the page head, where the frame offers it. */
  agentAction?: ReactNode;
}

/**
 * A kind the interface lists and does not edit: it has a rail item and a list, and no button
 * that starts an asset and no CLI entry. Without `view` its rows are not links.
 */
export interface BuildListedKind extends BuildKindBase {
  Editor?: undefined;
  /**
   * A page that shows one asset of the kind and writes nothing of its definition: no History
   * and no save. Publish and Delete go through the frame.
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
