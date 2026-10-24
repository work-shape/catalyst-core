import { useCallback, useState } from "react";
import type { OwnUsage } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import { usageNearNote } from "./usage-limit-block";

/** The note a person dismissed last: its limit's period and when that period ends. */
const DISMISSED_STORAGE_KEY = "catalyst.usage-note.dismissed";

function readDismissed(): string | undefined {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeDismissed(key: string): void {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, key);
  } catch {
    // Without storage the note stays dismissed until the page reloads.
  }
}

/**
 * The quiet note at 80 percent of the person's own limit (limits spec 3.1): shown once per
 * period. Dismissed, it stays away until the period ends and the next one is near again.
 */
export function useUsageNote(
  usage: OwnUsage | undefined,
  text: Pick<TranslationContextValue, "t" | "locale">
): { text: string; dismiss(): void } | undefined {
  const [dismissed, setDismissed] = useState(readDismissed);
  const note = usageNearNote(usage, text);
  const key = note?.key;
  const dismiss = useCallback(() => {
    if (key === undefined) return;
    storeDismissed(key);
    setDismissed(key);
  }, [key]);
  if (!note || note.key === dismissed) return undefined;
  return { text: note.text, dismiss };
}
