import type { ReactNode, Ref } from "react";
import type {
  AssetFileEntry,
  AssetFileRead,
  AssetFileWrite,
  AvailableIn,
  DependencyConsent
} from "../../../shared/api/asset-writes";
import type { BuildWriteOutcome } from "../build-refusals";
import type { BuildAsset, BuildHeadActions } from "./asset";

/** What the reader chose in the dialog that starts a new asset. */
export interface BuildAssetStart {
  /** The id. */
  name: string;
  /** The name people read. */
  title: string;
  /** What the asset does, in the reader's language, where its kind's dialog asks. */
  description?: string;
  /** Where a new asset of a kind that `startsInWorkspace` starts available. */
  availableIn?: AvailableIn;
  /** The name of the workspace `availableIn` names, for what the page says of it. */
  availableInName?: string;
  /** The definition a copy starts from. A new asset without it starts empty. */
  copyOf?: Record<string, unknown>;
}

/** What a save names beside the definition: an existing agent's draft, or a new agent's choice. */
type BuildSaveOptions =
  { expectedDraftRevision: number | null } | { dependencyConsent: DependencyConsent };

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
  /**
   * The reader's create of a new asset waits for an approval by one of these people, as the
   * instance answers it for the name and the owner. An existing asset says so itself.
   */
  createApproval?: { approverNames: string[] };
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
  /**
   * Where the asset sits and, where it differs, who uses it, for the page head. Absent while a
   * new asset is written.
   */
  place?: ReactNode;
  /** The way back to the kind's list, for the start of the page head. */
  back: ReactNode;
  /** The page's own actions, for the end of the page head: History and the menu with Delete. */
  actions: BuildHeadActions;
  /** What the frame offers an asset whose kind has a draft and a published revision. */
  draft?: BuildDraftFrame;
  /** What the frame says above the save bar: a conflict with the way to the newer version. */
  notice: ReactNode;
  /** Hears whether the page holds changes that are not saved: the frame asks before it is left. */
  onUnsavedChange(unsaved: boolean): void;
  /**
   * A new asset's page opened empty hears the name as the reader types it: it asks the instance
   * about the id it will make, as the create dialog asks. Absent on every other page.
   */
  onNewTitle?(title: string): void;
  /**
   * Saves the definition against the revision the page loaded, or creates the asset. A save of
   * an existing agent names the draft revision the page read, or `null` where it read none: it
   * writes the agent's draft, answers the draft revision it wrote and leaves the live agent and
   * the revision the page loaded as they are. The create of an agent may carry the reader's
   * choice to make what it uses available where it starts.
   */
  save(
    config: Record<string, unknown>,
    write?: BuildSaveOptions
  ): Promise<BuildWriteOutcome & { draftRevision?: number }>;
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
    /**
     * A save that was made answers the files it stored, each with its hash. A save of a skill
     * with a shared draft names the draft revision the page read and answers the one it wrote.
     */
    save(
      files: readonly AssetFileWrite[],
      write?: { expectedDraftRevision: number | null }
    ): Promise<BuildWriteOutcome & { stored?: readonly AssetFileEntry[]; draftRevision?: number }>;
  };
}

/**
 * What the frame offers the page of an asset whose kind has a draft and a published revision.
 * A further capability of drafts is one more member here, not a prop of every page.
 */
interface BuildDraftFrame {
  /**
   * What the frame says beside the name: that the saved draft is ahead of what is published,
   * or that nothing is.
   */
  state?: ReactNode;
  /** The reader may publish the asset: for an agent, its draft. */
  canPublish?: boolean;
  /**
   * A save of the asset writes its one shared draft, which a publish makes live: an agent's,
   * and a skill's that a team or the instance owns (SKILL-DRAFT-1).
   */
  shared?: boolean;
  /**
   * Hears which draft revision of the agent the page shows, or that it shows none: a restore
   * from the History names it.
   */
  onRead?(revision: number | null): void;
}
