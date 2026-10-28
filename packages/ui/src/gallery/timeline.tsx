import { Timeline, type TimelineRow } from "../data/timeline";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

/** Start and end of each row, in seconds from the run's start, with its depth and tone. */
const SPANS: readonly [number, number, number, TimelineRow["tone"]][] = [
  [0, 38, 0, "success"],
  [38, 251, 0, "success"],
  [38, 152, 1, "success"],
  [38, 251, 1, "success"],
  [38, 109, 1, "success"],
  [251, 262, 0, "success"]
];

function rows(text: GalleryText, at?: number): TimelineRow[] {
  return SPANS.map(([start, end, depth, tone], index) => {
    const label = text.timelineRows[index] ?? "";
    if (at !== undefined && start > at) return { id: label, label, depth };
    const running = at !== undefined && end > at;
    return {
      id: label,
      label,
      depth,
      start,
      ...(running ? {} : { end }),
      tone: running ? "info" : tone,
      ...(running ? {} : { meta: text.timelineTook[index] ?? "" })
    };
  });
}

export const timelineGalleryEntry: GalleryEntry = {
  name: "Timeline",
  components: ["Timeline"],
  render: (text) => (
    <>
      <Samples label={text.timelineRun}>
        <Timeline
          data-gallery-sample="timeline-run"
          className="w-full max-w-2xl"
          label={text.timelineLabel}
          rows={rows(text)}
          from={0}
          to={262}
        />
      </Samples>
      <Samples label={text.timelineReplay}>
        <Timeline
          data-gallery-sample="timeline-replay"
          className="w-full max-w-2xl"
          label={text.timelineLabel}
          rows={rows(text, 90)}
          from={0}
          to={262}
          at={90}
        />
      </Samples>
    </>
  )
};
