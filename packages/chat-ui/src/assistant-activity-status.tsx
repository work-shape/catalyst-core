import { useTranslation } from "./i18n";
import { useToolActivityLabel } from "./tool-activity";
import { Spinner } from "./ui/spinner";

const fallbackActivityKeys = [
  "preparing",
  "preparingAlt1",
  "preparingAlt2",
  "preparingAlt3",
  "preparingAlt4"
] as const;

export function AssistantActivityStatus({
  toolName,
  variationSeed
}: {
  toolName?: string;
  variationSeed?: string;
}) {
  const label = useAssistantActivityLabel({ toolName, variationSeed });

  return (
    <div
      className="flex max-w-3xl items-center gap-2 py-1 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Spinner size="sm" />
      <span>{label}</span>
    </div>
  );
}

export function useAssistantActivityLabel({
  toolName,
  variationSeed
}: {
  toolName?: string;
  variationSeed?: string;
}): string {
  const { locale, t } = useTranslation();
  const configuredLabel = useToolActivityLabel(toolName, locale);
  const toolLabel = configuredLabel ?? (toolName ? readableToolName(toolName) : undefined);
  const fallbackKey = fallbackActivityKeys[stableVariantIndex(variationSeed)] ?? "preparing";
  return toolLabel ? t("preparingTool", { tool: toolLabel }) : t(fallbackKey);
}

function stableVariantIndex(seed: string | undefined): number {
  if (!seed) {
    return 0;
  }
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % fallbackActivityKeys.length;
}

function readableToolName(toolName: string): string {
  const name = toolName.split(".").at(-1)?.replaceAll("_", " ").trim() ?? toolName;
  return name.length > 0 ? `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}` : toolName;
}
