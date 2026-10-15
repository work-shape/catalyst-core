import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { TimeMarker } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { dayMarkerLabel, dayOpeningMessages } from "./day-markers";

interface DayMarker {
  label: string;
  dateTime: string;
}

const noMarkers: ReadonlyMap<string, DayMarker> = new Map();
const DayMarkersContext = createContext<ReadonlyMap<string, DayMarker>>(noMarkers);

/**
 * Places the day markers of the open thread: one above its first message, and one above the
 * first message of each later day, in the reader's time zone. `messageTimes` holds when each
 * stored message was written, by id. A message the server has not stored yet, the one just
 * sent or the answer still coming, counts as written now, so its marker does not move once
 * the stored message takes its place.
 */
export function DayMarkersProvider({
  messageTimes,
  children
}: {
  messageTimes: Readonly<Record<string, string>>;
  children: ReactNode;
}) {
  const { locale, t } = useTranslation();
  // The ids alone: a streamed answer changes its message with every word, and the markers
  // only change when a message comes or goes.
  const ids = useAuiState((state) => state.thread.messages.map((message) => message.id).join("\n"));
  const markers = useMemo(() => {
    const now = new Date();
    const timed = ids
      ? ids.split("\n").map((id) => ({ id, at: messageTimes[id] ?? now.toISOString() }))
      : [];
    const placed = new Map<string, DayMarker>();
    for (const [id, at] of dayOpeningMessages(timed)) {
      placed.set(id, { label: dayMarkerLabel({ at, now, locale, t }), dateTime: at });
    }
    return placed;
  }, [ids, locale, messageTimes, t]);
  return <DayMarkersContext.Provider value={markers}>{children}</DayMarkersContext.Provider>;
}

/** The day marker above the message it is rendered with, where that message opens a day. */
export function MessageDayMarker() {
  const markers = useContext(DayMarkersContext);
  const messageId = useAuiState((state) => state.message.id);
  const marker = markers.get(messageId);
  if (!marker) {
    return null;
  }
  return (
    <TimeMarker
      label={marker.label}
      dateTime={marker.dateTime}
      className="-mb-2"
      data-testid="day-marker"
    />
  );
}
