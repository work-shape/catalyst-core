import type { AgentRunId, ConversationId } from "@vivd-catalyst/core";

export interface ResumableRun {
  conversationId: ConversationId;
  ownerUserId: string;
}

export interface ResumableRunEntry extends ResumableRun {
  runId: AgentRunId;
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

  readCurrentForConversation(conversationId: ConversationId, userId: string): ResumableRunEntry | undefined {
    for (const [runId, run] of [...this.runs.entries()].reverse()) {
      if (run.conversationId === conversationId && run.ownerUserId === userId) {
        return {
          ...run,
          runId: runId as AgentRunId
        };
      }
    }
    return undefined;
  }

  forget(runId: AgentRunId): void {
    this.runs.delete(runId);
  }
}
