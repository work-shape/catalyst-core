import { HoverCard, HoverCardContent, HoverCardTrigger } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";

export function ContextIndicator({
  inputTokens,
  compactThresholdTokens
}: {
  inputTokens: number;
  compactThresholdTokens: number;
}) {
  const { t } = useTranslation();
  const exactPercentage =
    inputTokens === 0
      ? 0
      : Math.min(100, Math.max(0, (inputTokens / compactThresholdTokens) * 100));
  const ringPercentage = inputTokens === 0 ? 0 : Math.max(1, exactPercentage);
  const percentage = formatPercentage(exactPercentage);
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
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
          aria-label={accessibleLabel}
          data-testid="context-indicator"
        >
          <svg viewBox="0 0 20 20" className="size-4 -rotate-90" aria-hidden="true">
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
              strokeDashoffset={100 - ringPercentage}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-auto px-3 py-2 text-center text-xs whitespace-nowrap"
      >
        <div className="text-muted-foreground">{t("contextWindow")}</div>
        <div className="mt-0.5 text-sm font-medium">
          {t("contextPercentFull", { percent: percentage })}
        </div>
        <div className="mt-0.5 text-muted-foreground">{detail}</div>
      </HoverCardContent>
    </HoverCard>
  );
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  }
  if (tokens >= 1_000) {
    const digits = tokens < 10_000 ? 1 : 0;
    return `${Number((tokens / 1_000).toFixed(digits))}k`;
  }
  return tokens.toLocaleString();
}

function formatPercentage(percentage: number): string {
  if (percentage > 0 && percentage < 0.1) {
    return "<0.1";
  }
  return String(Number(percentage.toFixed(percentage < 10 ? 1 : 0)));
}
