import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown, Bot, CircleAlert, Sparkles } from "lucide-react";
import type { DraftAttachment, SafeConfig } from "@vivd-catalyst/api-client";
import { AssistantComposer, type LocalUploadingAttachment } from "./assistant-composer";
import { ThreadMessage } from "./assistant-message";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

export function AssistantThread({
  config,
  selectedAgentName,
  notice,
  draftAttachments,
  localUploadingAttachments,
  sendBlockedReason,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment
}: {
  config: SafeConfig | undefined;
  selectedAgentName: string | undefined;
  notice: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
}) {
  const { t } = useTranslation();
  const agent = getSelectedAgent(config, selectedAgentName);
  const initialPrompts = agent?.initialPrompts ?? [];

  return (
    <section
      className="grid h-full min-h-0 min-w-0 overflow-hidden bg-background"
      aria-label="Chat"
    >
      <ThreadPrimitive.Root
        className="grid h-full min-h-0 min-w-0 overflow-hidden"
        style={{ ["--thread-max-width" as string]: "52rem" }}
      >
        <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-col overflow-y-auto overflow-x-hidden scroll-smooth">
          <div className="mx-auto flex min-h-full w-full max-w-[var(--thread-max-width)] flex-1 flex-col px-5 pt-20">
            {notice ? (
              <div className="mb-4 inline-flex w-fit max-w-full items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <CircleAlert size={17} aria-hidden="true" />
                <span>{notice}</span>
              </div>
            ) : null}

            <AuiIf condition={(state) => state.thread.isEmpty}>
              <ThreadWelcome
                agent={agent}
                fallbackWelcomeMessage={config?.ui.welcomeMessage ?? t("genericWelcome")}
                initialPrompts={initialPrompts}
              />
            </AuiIf>

            <div className="flex flex-col gap-5 pb-6 empty:hidden">
              <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
            </div>

            <ThreadPrimitive.ViewportFooter className="relative sticky bottom-0 z-10 mt-auto pb-4 pt-5 before:pointer-events-none before:absolute before:-top-11 before:inset-x-0 before:z-0 before:h-16 before:bg-gradient-to-t before:from-background before:to-background/0 before:content-[''] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:top-5 after:z-0 after:bg-background after:content-['']">
              <AuiIf condition={(state) => !state.thread.isEmpty}>
                <ThreadScrollToBottom />
              </AuiIf>
              <div className="relative z-10">
                <AssistantComposer
                  attachments={draftAttachments}
                  localUploadingAttachments={localUploadingAttachments}
                  sendBlockedReason={sendBlockedReason}
                  onFilesSelected={onFilesSelected}
                  onRemoveAttachment={onRemoveDraftAttachment}
                  onRetryAttachment={onRetryDraftAttachment}
                />
              </div>
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </section>
  );
}

function ThreadWelcome({
  agent,
  fallbackWelcomeMessage,
  initialPrompts
}: {
  agent: SafeConfig["agents"][number] | undefined;
  fallbackWelcomeMessage: string | undefined;
  initialPrompts: Array<{ title: string; prompt: string }>;
}) {
  const { t } = useTranslation();

  return (
    <div className="my-auto grid min-h-[20rem] content-center gap-5 py-8">
      <div className="grid gap-3">
        <span className="grid size-10 place-items-center rounded-lg border bg-card text-primary shadow-xs">
          <Bot size={20} aria-hidden="true" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold tracking-normal">
            {agent?.welcomeMessage ?? fallbackWelcomeMessage ?? "How can I help?"}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {t("agentReady", { agent: agent?.displayName ?? t("agentFallback") })}
          </p>
        </div>
      </div>
      {initialPrompts.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {initialPrompts.map((initialPrompt) => (
            <ThreadPrimitive.Suggestion
              key={`${initialPrompt.title}:${initialPrompt.prompt}`}
              prompt={initialPrompt.prompt}
              className={cn(
                "group/suggestion grid min-h-20 content-between rounded-md border bg-card p-3 text-left text-sm shadow-xs transition-colors",
                "hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              )}
            >
              <span className="font-medium">{initialPrompt.title}</span>
              <Sparkles size={15} className="mt-2 text-muted-foreground group-hover/suggestion:text-primary" aria-hidden="true" />
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThreadScrollToBottom() {
  const { t } = useTranslation();

  return (
    <ThreadPrimitive.ScrollToBottom
      className="absolute -top-5 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:invisible"
      aria-label={t("scrollToBottom")}
      title={t("scrollToBottom")}
    >
      <ArrowDown size={16} aria-hidden="true" />
    </ThreadPrimitive.ScrollToBottom>
  );
}

function getSelectedAgent(
  config: SafeConfig | undefined,
  selectedAgentName: string | undefined
): SafeConfig["agents"][number] | undefined {
  return (
    config?.agents.find((candidate) => candidate.name === selectedAgentName) ??
    config?.agents.find((candidate) => candidate.name === config.defaultAgentName) ??
    config?.agents[0]
  );
}
