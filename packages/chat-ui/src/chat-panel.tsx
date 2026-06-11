import { type FormEvent, useLayoutEffect, useRef } from "react";
import { Bot, CircleAlert, Send } from "lucide-react";
import type { Message, SafeConfig } from "@agent-chat-platform/api-client";
import { useTranslation } from "./i18n";
import { MessageBubble } from "./message-bubble";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";

export function ChatPanel({
  config,
  messages,
  notice,
  draft,
  sending,
  onDraftChange,
  onSubmit
}: {
  config: SafeConfig | undefined;
  messages: Message[];
  notice: string | undefined;
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();
  const agent = getDefaultAgent(config);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const shiftPressedRef = useRef(false);

  useLayoutEffect(() => {
    const composerInput = composerInputRef.current;
    if (!composerInput) {
      return;
    }

    composerInput.style.height = "auto";
    const borderHeight = composerInput.offsetHeight - composerInput.clientHeight;
    composerInput.style.height = `${composerInput.scrollHeight + borderHeight}px`;
  }, [draft]);

  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    const composerInput = composerInputRef.current;
    if (!composerForm || !composerInput) {
      return;
    }
    const form = composerForm;
    const input = composerInput;

    function onWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Shift") {
        shiftPressedRef.current = true;
      }
    }

    function onWindowKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") {
        shiftPressedRef.current = false;
      }
    }

    function onWindowBlur() {
      shiftPressedRef.current = false;
    }

    function onComposerKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.isComposing) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const hasModifier =
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.getModifierState("Shift") ||
        shiftPressedRef.current;

      if (hasModifier) {
        const selectionStart = input.selectionStart;
        const selectionEnd = input.selectionEnd;
        const nextValue = `${input.value.slice(0, selectionStart)}\n${input.value.slice(selectionEnd)}`;

        onDraftChange(nextValue);
        requestAnimationFrame(() => {
          input.setSelectionRange(selectionStart + 1, selectionStart + 1);
        });
        return;
      }

      input.form?.requestSubmit();
    }

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    window.addEventListener("keyup", onWindowKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    form.addEventListener("keydown", onComposerKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
      window.removeEventListener("keyup", onWindowKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
      form.removeEventListener("keydown", onComposerKeyDown, { capture: true });
    };
  }, [onDraftChange]);

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background" aria-label="Chat">
      <div className="grid min-h-0 content-start gap-4 overflow-auto bg-background px-5 pb-5 pt-20" aria-live="polite">
        {notice ? (
          <div className="inline-flex w-fit max-w-[min(42rem,100%)] items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <CircleAlert size={17} aria-hidden="true" />
            <span>{notice}</span>
          </div>
        ) : null}

        {messages.length === 0 ? (
          <div className="inline-flex w-fit max-w-[min(42rem,100%)] items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            <Bot size={22} aria-hidden="true" />
            <p>{agent?.welcomeMessage ?? config?.ui.welcomeMessage ?? t("genericWelcome")}</p>
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}

        {sending ? (
          <div className="inline-flex w-fit items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-600" />
            {t("thinking")}
          </div>
        ) : null}
      </div>

      <form ref={composerFormRef} className="grid grid-cols-[minmax(0,1fr)_2.75rem] gap-2.5 border-t bg-background px-5 py-4" onSubmit={onSubmit}>
        <Textarea
          ref={composerInputRef}
          className="max-h-40 min-h-11 resize-none overflow-y-auto py-2.5"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={t("messagePlaceholder")}
          rows={1}
        />
        <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label={t("sendMessage")}>
          <Send size={18} aria-hidden="true" />
        </Button>
      </form>
    </section>
  );
}

function getDefaultAgent(config: SafeConfig | undefined): SafeConfig["agents"][number] | undefined {
  return config?.agents.find((candidate) => candidate.name === config.defaultAgentName) ?? config?.agents[0];
}
