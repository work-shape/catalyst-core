export function formatElapsedSeconds(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  return minutes > 0 ? `${minutes}m ${wholeSeconds % 60}s` : `${wholeSeconds}s`;
}

export function formatWorkHistoryLabel(label: string, durationMs?: number): string {
  return durationMs === undefined
    ? label
    : `${label} · ${formatElapsedSeconds(durationMs / 1000)}`;
}
