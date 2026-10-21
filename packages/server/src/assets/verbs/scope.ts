import type { AgentDraftWorkflow } from "../agent-drafts";
import type { AssetCall } from "../asset-access";
import type { AssetDraftWorkflow } from "../asset-draft-service";
import type { AssetReadWorkflow } from "../asset-read-service";
import type { AssetAddress, AssetTarget } from "../asset-target";
import type { authorizeInteractiveWrite } from "../asset-write-rules";
import type { AssetWorkflowOptions } from "../../types";
import type { AssetWriteSurface } from "../../asset-kinds/shared";

/** The surfaces an interactive write arrives through; a sync is asked by its own rules. */
export type EditingSurface = Exclude<AssetWriteSurface, "sync">;

/**
 * What a verb of `AssetWorkflow` works with: the options of the workflow, its parts, and the
 * steps every verb shares. Each verb is a file of its own beside this one; the class holds the
 * scope and answers each call with its verb.
 */
export interface AssetVerbScope {
  readonly options: AssetWorkflowOptions;
  readonly drafts: AssetDraftWorkflow;
  readonly agentDrafts: AgentDraftWorkflow;
  readonly reads: AssetReadWorkflow;
  /** The asset an address names, of a kind whose module is on. */
  target(address: AssetAddress): Promise<AssetTarget>;
  /** The same scope over other options, such as those of a transaction. */
  within(options: AssetWorkflowOptions): AssetVerbScope;
  /** The editing switch of the instance, asked for the surface the write arrives through. */
  authorizeEditing(
    call: AssetCall,
    surface: EditingSurface
  ): ReturnType<typeof authorizeInteractiveWrite>;
}
