import { useTranslation } from "./i18n";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

export function ContextIndicator({
  inputTokens,
  compactThresholdTokens
}: {
  inputTokens: number;
  compactThresholdTokens: number;
}) {
  const { t } = useTranslation();
  const percentage =
    inputTokens === 0
      ? 0
      : Math.min(
          100,
          Math.max(1, Math.round((inputTokens / compactThresholdTokens) * 100))
        );
  const detail = t("contextTokensUsed", {
    used: formatCompactTokens(inputTokens),
    limit: formatCompactTokens(compactThresholdTokens)
  });
  const accessibleLabel = t("contextUsageAccessible", {
    percent: percentage,
    used: formatCompactTokens(inputTokens),
    limit: formatCompactTokens(compactThresholdTokens)
  });

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
          aria-label={accessibleLabel}
          data-testid="context-indicator"
        >
          <svg
            viewBox="0 0 20 20"
            className="size-5 -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="10"
              cy="10"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="opacity-20"
            />
            <circle
              cx="10"
              cy="10"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - percentage}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-60 text-center"
      >
        <div className="text-sm text-muted-foreground">{t("contextWindow")}</div>
        <div className="mt-1 text-xl font-medium">
          {t("contextPercentFull", { percent: percentage })}
        </div>
        <div className="mt-1 text-base">{detail}</div>
      </HoverCardContent>
    </HoverCard>
  );
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  }
  if (tokens >= 1_000) {
    return `${Number((tokens / 1_000).toFixed(0))}k`;
  }
  return tokens.toLocaleString();
}
