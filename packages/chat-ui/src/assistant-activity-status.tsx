import { useTranslation } from "./i18n";
import { useToolActivityLabel } from "./tool-activity";
import { Spinner } from "./ui/spinner";

export function AssistantActivityStatus({ toolName }: { toolName?: string }) {
  const { locale, t } = useTranslation();
  const configuredLabel = useToolActivityLabel(toolName, locale);
  const label = configuredLabel ?? (toolName ? readableToolName(toolName) : undefined);

  return (
    <div
      className="flex max-w-3xl items-center gap-2 py-1 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Spinner size="sm" />
      <span>{label ? t("preparingTool", { tool: label }) : t("preparing")}</span>
    </div>
  );
}

function readableToolName(toolName: string): string {
  const name = toolName.split(".").at(-1)?.replaceAll("_", " ").trim() ?? toolName;
  return name.length > 0 ? `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}` : toolName;
}
