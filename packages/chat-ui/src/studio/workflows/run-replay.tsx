import { ChevronDown, ChevronLeft, ChevronRight, Pause, Play, SkipBack } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, IconButton, Timeline, cn } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { formatDuration, formatTime } from "../../shared/locale-format";
import { timelineRows, type ReplayMoment } from "./run-replay-model";
import { placedSteps } from "./workflow-canvas-model";
import type { WorkflowStepRunView, WorkflowStepView } from "./workflow-views";

/** How long one moment of a replay stands before the next. */
const PLAY_MS = 1_100;

/**
 * The timeline of a run, folded under one button: a bar per step that ran and per path of a
 * parallel block, and the controls that play the run back moment by moment. The page draws
 * the canvas at the moment the replay stands at; `at` is that moment's place, or nothing for
 * the run as it stands now.
 */
export function RunReplay({
  steps,
  stepRuns,
  moments,
  now,
  at,
  onAt
}: {
  steps: readonly WorkflowStepView[];
  stepRuns: readonly WorkflowStepRunView[];
  moments: readonly ReplayMoment[];
  now: Date;
  at: number | undefined;
  onAt(at: number | undefined): void;
}) {
  const translation = useTranslation();
  const { t, locale } = translation;
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const last = moments.length - 1;
  const index = at === undefined ? undefined : Math.min(at, last);
  const moment = index === undefined ? undefined : moments[index];

  // Playing moves on one moment at a time and stops at the last.
  useEffect(() => {
    if (!playing) return undefined;
    if (index !== undefined && index >= last) {
      setPlaying(false);
      return undefined;
    }
    const timer = window.setTimeout(
      () => onAt(index === undefined ? 0 : index + 1),
      index === undefined ? 0 : PLAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [playing, index, last, onAt]);

  const first = moments[0]?.at;
  const end = Math.max(moments.at(-1)?.at ?? now.getTime(), first ?? 0);
  const reach = moment?.at ?? now.getTime();
  // Every row stays in its place while the run plays back; a bar reaches the moment shown.
  const rows = useMemo(
    () =>
      timelineRows(steps, stepRuns, reach, translation).map((row) => {
        if (moment === undefined || row.start === undefined) return row;
        if (row.start > moment.at) {
          const { start: _start, end: _end, meta: _meta, description: _description, ...rest } = row;
          return rest;
        }
        if (row.end !== undefined && row.end <= moment.at) return row;
        const { end: _end, ...rest } = row;
        return {
          ...rest,
          tone: "info" as const,
          meta: formatDuration(moment.at - row.start, locale)
        };
      }),
    [steps, stepRuns, reach, translation, moment, locale]
  );
  const placed = useMemo(() => placedSteps(steps), [steps]);
  const names = (ids: readonly string[]) =>
    ids.map((id) => placed.get(id)?.step.name ?? id).join(", ");
  const happened =
    moment === undefined || index === undefined
      ? undefined
      : [
          t("workflows.replay.at", {
            index: (index + 1).toLocaleString(locale),
            count: moments.length.toLocaleString(locale),
            time: formatTime(new Date(moment.at).toISOString(), locale)
          }),
          moment.started.length === 0
            ? undefined
            : t("workflows.replay.started", { names: names(moment.started) }),
          moment.ended.length === 0
            ? undefined
            : t("workflows.replay.ended", { names: names(moment.ended) })
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
  const fold = () => {
    setOpen(!open);
    if (open) {
      setPlaying(false);
      onAt(undefined);
    }
  };
  return (
    <section
      data-run-replay=""
      aria-label={t("workflows.replay.label")}
      className="shrink-0 border-b px-(--layout-gutter) py-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          aria-expanded={open}
          data-replay-open=""
          onClick={fold}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "transition-transform motion-reduce:transition-none",
              !open && "-rotate-90"
            )}
          />
          {t("workflows.replay.open")}
        </Button>
        {open && moments.length > 0 ? (
          <>
            <IconButton
              size="sm"
              label={t("workflows.replay.first")}
              disabled={index === 0}
              onClick={() => {
                setPlaying(false);
                onAt(0);
              }}
            >
              <SkipBack aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              label={t("workflows.replay.back")}
              disabled={index === 0 || last < 1}
              data-replay-back=""
              onClick={() => {
                setPlaying(false);
                onAt(Math.max(0, (index ?? last) - 1));
              }}
            >
              <ChevronLeft aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              label={t(playing ? "workflows.replay.pause" : "workflows.replay.play")}
              data-replay-play=""
              onClick={() => {
                // Played from the end, a replay starts again at the beginning.
                if (!playing && (index === undefined || index >= last)) onAt(0);
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </IconButton>
            <IconButton
              size="sm"
              label={t("workflows.replay.forward")}
              disabled={index === undefined || index >= last}
              data-replay-forward=""
              onClick={() => {
                setPlaying(false);
                onAt(Math.min(last, (index ?? last) + 1));
              }}
            >
              <ChevronRight aria-hidden="true" />
            </IconButton>
            {at === undefined ? null : (
              <Button
                variant="outline"
                size="sm"
                className="ml-1"
                onClick={() => {
                  setPlaying(false);
                  onAt(undefined);
                }}
              >
                {t("workflows.replay.whole")}
              </Button>
            )}
            <p
              aria-live="polite"
              data-replay-moment=""
              className="ml-1 min-w-0 basis-full text-caption text-muted-foreground sm:basis-auto"
            >
              {happened}
            </p>
          </>
        ) : null}
      </div>
      {open ? (
        rows.length === 0 || first === undefined ? (
          <p className="pb-1 text-caption text-muted-foreground">{t("workflows.replay.empty")}</p>
        ) : (
          <Timeline
            className="mt-1.5 max-h-[28vh] overflow-y-auto pb-1"
            label={t("workflows.replay.label")}
            rows={rows}
            from={first}
            to={end}
            {...(moment === undefined ? {} : { at: moment.at })}
          />
        )
      ) : null}
    </section>
  );
}
