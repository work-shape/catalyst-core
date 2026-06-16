import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

export function AssistantCursor({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <span
      className={cn("inline-flex h-6 items-center px-1 align-baseline text-foreground", className)}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true" className="font-[revert] leading-none">
        {"\u25CF"}
      </span>
      <span className="sr-only">{t("thinking")}</span>
    </span>
  );
}
