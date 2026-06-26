import type { AgentRunId, ConversationId } from "@vivd-catalyst/core";

export interface ResumableRun {
  conversationId: ConversationId;
  ownerUserId: string;
}

export class ResumableRunRegistry {
  private readonly runs = new Map<string, ResumableRun>();

  remember(runId: AgentRunId, run: ResumableRun): void {
    this.runs.set(runId, run);
  }

  readForUser(runId: AgentRunId, userId: string): ResumableRun | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      this.runs.delete(runId);
      return undefined;
    }
    if (run.ownerUserId !== userId) {
      return undefined;
    }
    return run;
  }

  forget(runId: AgentRunId): void {
    this.runs.delete(runId);
  }
}
