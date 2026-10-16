import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { TimeMarker } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { shouldShowRunActivity } from "./thread-activity";
import {
  createThreadTimes,
  dayMarkerLabel,
  dayOpeningMessages,
  msUntilNextMidnight
} from "./thread-time";

interface DayMarker {
  label: string;
  dateTime: string;
}

const noMarkers: ReadonlyMap<string, DayMarker> = new Map();
const DayMarkersContext = createContext<ReadonlyMap<string, DayMarker>>(noMarkers);

/**
 * Places the day markers of the open thread: one above its first message, and one above the
 * first message of each later day, in the reader's time zone. `messageTimes` holds when each
 * message the thread shows was written, by id. The message being sent and the answer streaming
 * in are written now until the server's moment arrives; see `createThreadTimes`.
 */
export function DayMarkersProvider({
  messageTimes,
  conversationRunning,
  optimisticPending,
  children
}: {
  messageTimes: Readonly<Record<string, string>>;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  children: ReactNode;
}) {
  const { locale, t } = useTranslation();
  // The ids alone: a streamed answer changes its message with every word, and the markers
  // only change when a message comes or goes.
  const ids = useAuiState((state) => state.thread.messages.map((message) => message.id).join("\n"));
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const busy = shouldShowRunActivity({ conversationRunning, optimisticPending, threadRunning });
  const [threadTimes] = useState(createThreadTimes);
  const today = useToday();
  const markers = useMemo(() => {
    // `today` is among the dependencies: at midnight the labels are read again.
    const now = new Date();
    const timed = threadTimes({ ids: ids ? ids.split("\n") : [], stored: messageTimes, busy, now });
    const placed = new Map<string, DayMarker>();
    for (const [id, at] of dayOpeningMessages(timed)) {
      placed.set(id, { label: dayMarkerLabel({ at, now, locale, t }), dateTime: at });
    }
    return placed;
  }, [busy, ids, locale, messageTimes, t, threadTimes, today]);
  return <DayMarkersContext.Provider value={markers}>{children}</DayMarkersContext.Provider>;
}

/** The moment of the latest local midnight passed while the thread was open, or of its mount. */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    // One timer to the next midnight; it sets the next one when it has run.
    const timer = window.setTimeout(() => setToday(new Date()), msUntilNextMidnight(new Date()));
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
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
