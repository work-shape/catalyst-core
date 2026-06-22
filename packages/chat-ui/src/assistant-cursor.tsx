import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

export function AssistantCursor({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <span
      className={cn("inline-flex h-6 w-7 items-center justify-center align-baseline text-foreground", className)}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true" className="chat-assistant-cursor-dot" />
      <span className="sr-only">{t("thinking")}</span>
    </span>
  );
}
