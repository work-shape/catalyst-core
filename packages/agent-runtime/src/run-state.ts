import {
  AppError,
  type AgentRunFailureCategory,
  type AgentRunId,
  type AgentRunStatus,
  type AgentRuntimeEvent,
  type AgentRuntimeObserveOptions,
  type ChatMessage
} from "@vivd-catalyst/core";

type AgentRuntimeEventDraft = AgentRuntimeEvent extends infer TEvent
  ? TEvent extends AgentRuntimeEvent
    ? Omit<TEvent, "sequence" | "createdAt">
    : never
  : never;

export interface RunStateOptions {
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

export interface RunFailureError {
  code: string;
  message: string;
  category: AgentRunFailureCategory;
}

export interface RunStateReasoningSummary {
  id: string;
  text: string;
}

export function toRunFailureError(error: unknown): RunFailureError {
  const appError = error instanceof AppError ? error : undefined;
  return {
    code: appError?.code ?? "INTERNAL",
    message: appError && appError.code !== "INTERNAL" ? appError.message : "Agent run failed",
    category: categorizeRunFailure(error)
  };
}

function categorizeRunFailure(error: unknown): AgentRunFailureCategory {
  if (error instanceof AppError) {
    return error.code === "INTERNAL" ? "internal_error" : "app_error";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "abort_error";
  }
  if (error instanceof Error) {
    return "internal_error";
  }
  return "unknown_error";
}

export class RunState {
  readonly runId: AgentRunId;
  readonly startedAt = new Date().toISOString();
  private status: AgentRunStatus = "running";
  private sequence = 0;
  private closed = false;
  private cancellationStarted = false;
  private messageCompleted = false;
  private streamedText = "";
  private readonly reasoningById = new Map<string, string>();
  private readonly events: AgentRuntimeEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly onEvent: RunStateOptions["onEvent"];
  private eventWriteQueue: Promise<void> = Promise.resolve();

  constructor(runId: AgentRunId, options: RunStateOptions = {}) {
    this.runId = runId;
    this.onEvent = options.onEvent;
  }

  getStatus(): AgentRunStatus {
    return this.status;
  }

  waitForEventWrites(): Promise<void> {
    return this.eventWriteQueue;
  }

  async *observe(options: AgentRuntimeObserveOptions = {}): AsyncIterable<AgentRuntimeEvent> {
    let index = this.events.findIndex(
      (event) => event.sequence > (options.afterSequence ?? 0)
    );
    if (index < 0) {
      index = this.events.length;
    }
    while (true) {
      while (index < this.events.length) {
        const event = this.events[index];
        if (!event) {
          break;
        }
        index += 1;
        yield event;
      }
      if (this.closed) {
        await this.eventWriteQueue;
        return;
      }
      await this.waitForEvent();
    }
  }

  message(message: ChatMessage): void {
    this.emit({
      type: "message_delta",
      runId: this.runId,
      delta: message.text
    });
    this.completeMessage(message);
  }

  completeMessage(message: ChatMessage): void {
    this.emitRuntimeEvent({
      type: "message_completed",
      runId: this.runId,
      message: {
        id: message.id,
        role: "assistant",
        text: message.text,
        metadata: message.metadata
      }
    });
  }

  emit(event: AgentRuntimeEventDraft): void {
    this.emitRuntimeEvent(event);
  }

  beginCancellation(): string | undefined {
    if (this.closed) {
      return undefined;
    }
    this.status = "cancelling";
    this.cancellationStarted = true;
    return !this.messageCompleted && this.streamedText.length > 0 ? this.streamedText : undefined;
  }

  getReasoningSummaries(): RunStateReasoningSummary[] {
    return [...this.reasoningById.entries()]
      .map(([id, text]) => ({ id, text }))
      .filter((summary) => summary.text.length > 0);
  }

  complete(): void {
    if (this.closed) {
      return;
    }
    this.status = "completed";
    this.emitRuntimeEvent(
      {
        type: "run_completed",
        runId: this.runId
      },
      { allowDuringCancellation: true }
    );
    this.close();
  }

  cancel(reason?: string, partialMessage?: ChatMessage): void {
    if (this.closed) {
      return;
    }
    this.cancellationStarted = true;
    this.status = "cancelled";
    if (partialMessage && !this.messageCompleted) {
      this.emitRuntimeEvent(
        {
          type: "message_completed",
          runId: this.runId,
          message: {
            id: partialMessage.id,
            role: "assistant",
            text: partialMessage.text,
            metadata: partialMessage.metadata
          }
        },
        { allowDuringCancellation: true }
      );
    }
    this.emitRuntimeEvent(
      {
        type: "run_cancelled",
        runId: this.runId,
        reason
      },
      { allowDuringCancellation: true }
    );
    this.close();
  }

  fail(error: unknown, failure: RunFailureError = toRunFailureError(error)): void {
    if (this.closed) {
      return;
    }
    this.status = "failed";
    this.emitRuntimeEvent(
      {
        type: "run_failed",
        runId: this.runId,
        error: failure
      },
      { allowDuringCancellation: true }
    );
    this.close();
  }

  private emitRuntimeEvent(
    event: AgentRuntimeEventDraft,
    options: { allowDuringCancellation?: boolean } = {}
  ): void {
    if (this.closed || (this.cancellationStarted && !options.allowDuringCancellation)) {
      return;
    }
    this.sequence += 1;
    const runtimeEvent = {
      ...event,
      sequence: this.sequence,
      createdAt: new Date().toISOString()
    } as AgentRuntimeEvent;
    if (runtimeEvent.type === "message_delta") {
      this.streamedText += runtimeEvent.delta;
    }
    if (runtimeEvent.type === "reasoning_delta") {
      this.reasoningById.set(
        runtimeEvent.id,
        `${this.reasoningById.get(runtimeEvent.id) ?? ""}${runtimeEvent.delta}`
      );
    }
    if (runtimeEvent.type === "message_completed") {
      this.messageCompleted = true;
      this.streamedText = runtimeEvent.message.text;
    }
    this.events.push(runtimeEvent);
    this.persistEvent(runtimeEvent);
    this.flush();
  }

  private waitForEvent(): Promise<void> {
    return new Promise((resolve) => {
      const listener = () => {
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
    });
  }

  private close(): void {
    this.closed = true;
    this.flush();
  }

  private flush(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private persistEvent(event: AgentRuntimeEvent): void {
    if (!this.onEvent) {
      return;
    }
    this.eventWriteQueue = this.eventWriteQueue
      .then(() => this.onEvent?.(event))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn("Failed to persist agent run observation", error);
      });
  }
}
