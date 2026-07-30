import { useTranslation } from "./i18n";

export function ContextIndicator({
  inputTokens,
  compactThresholdTokens
}: {
  inputTokens: number;
  compactThresholdTokens: number;
}) {
  const { t } = useTranslation();
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((inputTokens / compactThresholdTokens) * 100))
  );
  const detail = t("contextUsageDetail", {
    percent: percentage,
    limit: formatCompactTokens(compactThresholdTokens)
  });

  return (
    <span
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground"
      title={detail}
      aria-label={`${t("contextUsage")}: ${detail}`}
      data-testid="context-indicator"
    >
      <svg
        viewBox="0 0 20 20"
        className="size-[18px] -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="10"
          cy="10"
          r="7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          className="opacity-20"
        />
        <circle
          cx="10"
          cy="10"
          r="7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - percentage}
        />
      </svg>
      <span>{percentage}%</span>
    </span>
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
