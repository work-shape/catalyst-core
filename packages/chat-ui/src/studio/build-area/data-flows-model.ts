// The data Workflows that fill or process a Knowledge Base or a Data Store, as the instance
// derives them from the published definitions each time it is asked. The Knowledge Base and
// the store never name a Workflow; the Workflow names what it writes to. Of the Workflows the
// reader may not read, the instance tells only how many there are.

/** One data Workflow: its asset id, its name (the slug its page is opened by) and its title. */
export interface DataFlowRef {
  id: string;
  name: string;
  title: string;
}

/** What `dataFlows` answers on the state of a Knowledge Base and on what uses a store. */
export interface DataFlows {
  /** The Workflows whose steps put items in, withdraw them or propose records. */
  fills: readonly DataFlowRef[];
  /** The Workflows whose steps process pending items with `put_processed`. */
  processes: readonly DataFlowRef[];
  /** How many more of each the reader may not read. Never their names. */
  hidden: { fills: number; processes: number };
  /** The instance has more published Workflows than one read looks through. */
  truncated: boolean;
}

export type DataFlowRole = "fills" | "processes";

/** Whether the answer names or counts any Workflow in this role: only then is there a section. */
export function hasDataFlows(flows: DataFlows | undefined, role: DataFlowRole): boolean {
  return flows !== undefined && (flows[role].length > 0 || flows.hidden[role] > 0);
}
