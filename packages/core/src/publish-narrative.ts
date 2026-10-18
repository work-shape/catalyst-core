import type { ActorAccess } from "./permissions";

// The plain sentence a publish question opens with (PUBQ-1), and what the stored-data module
// tells it of who sees which stored data (DS-13b). Spec: events-workflows-and-guardrails.md,
// The publish question.

/**
 * What making one revision live does, in the reader's language: one summary of what runs,
 * when, as which account, what it reads, writes and sends and who sees it, and one warning for
 * each step a guardrail in force will or may stop. Names and counts only, never a row value.
 */
export interface PublishNarrative {
  summary: string;
  warnings: string[];
}

/**
 * Who may use an App or a Knowledge Base, counted. Instance admins hold every right by their
 * role and hold no grant row, so they are never counted and always have access.
 */
export interface PublishNarrativeAudience {
  /** The workspace that owns it, whose members use it by being members. */
  workspace?: { title: string; members: number };
  /** How many hold its use by a grant row, shown to the reader or not. Holders, not people. */
  holders: number;
}

/** A store an App revision reads, and who fills it from where, as the App declares it. */
export interface PublishNarrativeStore {
  title: string;
  /** No store the App may reach stands under the name. */
  unavailable: boolean;
  /** The published Workflows and Apps that add rows to it, with the Connections they call. */
  fillers: readonly { title: string; connections: readonly string[] }[];
}

/** The readers of one store a Workflow revision writes. */
export interface PublishNarrativeStoreReaders {
  /** The store's name, as the Workflow's steps name it. */
  store: string;
  title: string;
  /** The published Apps on it and Knowledge Bases on it the reader may be shown. */
  readers: readonly {
    kind: "app" | "knowledge_base";
    title: string;
    audience: PublishNarrativeAudience;
  }[];
  /** How many more read it whom the reader may not be shown. */
  hidden: number;
  /**
   * More published Apps, Knowledge Bases or grant rows exist than one bounded read looks
   * through: there may be more readers, or more in an audience, than are named.
   */
  truncated: boolean;
}

/**
 * What the stored-data module answers the narrative. It reads no database of a store, and
 * names only what the reader may be shown. Absent where the module is off.
 */
export interface PublishNarrativeStoredData {
  /** Of one stored revision of an App: who may use it and the stores it reads. */
  appRevision(
    access: ActorAccess,
    app: string,
    revision: number
  ): Promise<{
    audience?: PublishNarrativeAudience;
    stores: readonly PublishNarrativeStore[];
    /**
     * More published assets or grant rows exist than one bounded read looks through: the
     * audience or the stores' sources may be incomplete.
     */
    truncated: boolean;
  }>;
  /** Of the stores a Workflow writes: who reads each of them through Apps and Knowledge Bases. */
  storeReaders(
    access: ActorAccess,
    stores: readonly string[]
  ): Promise<readonly PublishNarrativeStoreReaders[]>;
}
