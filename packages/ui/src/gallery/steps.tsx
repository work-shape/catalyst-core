import { CircleSlash } from "lucide-react";
import { CodeBlock } from "../data/code-block";
import { Step, Steps } from "../data/steps";
import { Banner } from "../feedback/banner";
import { Progress } from "../feedback/progress";
import { Badge } from "../status/badge";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

const outputSample = JSON.stringify({ customers: 600, pages: 12, source: "accounting" }, null, 2);

/** A kind of step with what it touches after it, as a link. */
function Kind({ kind, text }: { kind: string; text: GalleryText }) {
  return (
    <>
      {kind} ·{" "}
      <a href="#steps" className="underline" onClick={(event) => event.preventDefault()}>
        {text.stepSource}
      </a>
    </>
  );
}

/** A list that is only described: what happens, in order, with one list inside a step. */
function DescribedSteps({ text }: { text: GalleryText }) {
  return (
    <Steps label={text.stepsListLabel} data-gallery-sample="steps-described">
      <Step marker={1} eyebrow={text.stepKindStart} description={text.stepStartText} />
      <Step
        marker={2}
        eyebrow={<Kind kind={text.stepKindRead} text={text} />}
        title={text.stepReadTitle}
        description={text.stepReadText}
      />
      <Step marker={3} eyebrow={text.stepKindEach}>
        <Steps nested label={text.stepsInnerLabel}>
          <Step
            marker="a"
            eyebrow={<Kind kind={text.stepKindRead} text={text} />}
            title={text.stepLoadTitle}
            description={text.stepLoadText}
          />
          <Step
            marker="b"
            eyebrow={text.stepKindScript}
            title={text.stepCheckTitle}
            description={text.stepCheckText}
            note={text.stepCheckNote}
            badge={
              <Badge size="sm" tone="warning">
                {text.stepBadgeChanged}
              </Badge>
            }
          />
          <Step
            marker="c"
            eyebrow={text.stepKindWrite}
            title={text.stepStoreTitle}
            description={text.stepStoreText}
            badge={
              <Badge size="sm" tone="accent">
                {text.stepBadgeNew}
              </Badge>
            }
          />
        </Steps>
      </Step>
      <Step
        marker={4}
        eyebrow={text.stepKindSummary}
        title={text.stepSummaryTitle}
        description={text.stepSummaryText}
        note={text.stepSummaryNote}
      />
      <Step marker={5} eyebrow={text.stepKindResult} description={text.stepResultText} />
    </Steps>
  );
}

/** A list of something that ran: every state, bodies that unfold and one that is open. */
function StateSteps({ text }: { text: GalleryText }) {
  return (
    <Steps label={text.stepsListLabel} data-gallery-sample="steps-states">
      <Step
        state="done"
        eyebrow={text.stepKindStart}
        description={text.stepStartText}
        meta={text.stepMetaStart}
      />
      <Step
        expandable
        state="done"
        eyebrow={<Kind kind={text.stepKindRead} text={text} />}
        title={text.stepReadTitle}
        description={text.stepReadResult}
        meta={text.stepMetaShort}
      >
        <CodeBlock
          label={text.stepOutputLabel}
          code={outputSample}
          lineNumbers={false}
          maxLines={3}
          footer={text.codeCutFooter}
        />
      </Step>
      <Step state="running" eyebrow={text.stepKindEach} meta={text.stepMetaRunning}>
        <div className="grid gap-1.5">
          <Progress
            label={text.progressEntries}
            max={600}
            parts={[
              { value: 210, tone: "success" },
              { value: 2, tone: "danger" }
            ]}
            valueLabel={text.progressEntriesEarly}
          />
          <p className="text-caption text-muted-foreground">{text.stepProgressCounts}</p>
        </div>
      </Step>
      <Step
        expandable
        defaultExpanded
        state="failed"
        eyebrow={text.stepKindScript}
        title={text.stepCheckTitle}
        meta={text.stepMetaShort}
      >
        <Banner tone="danger" title={text.stepFailure}>
          {text.stepFailureNext}
        </Banner>
      </Step>
      <Step
        state="waiting"
        eyebrow={text.stepKindWrite}
        title={text.stepStoreTitle}
        meta={text.stepMetaWaiting}
      />
      <Step
        state="cancelled"
        eyebrow={text.stepKindSummary}
        title={text.stepSummaryTitle}
        description={text.stepCancelledText}
      />
      <Step
        state="limit_reached"
        eyebrow={text.stepKindSummary}
        title={text.stepSummaryTitle}
        description={text.stepLimitText}
      />
      <Step
        marker={<CircleSlash aria-hidden="true" />}
        eyebrow={text.stepKindWrite}
        title={text.stepStoreTitle}
        description={text.stepStoreText}
      />
      <Step expandable state="done" tone="warning" marker="!" eyebrow={text.stepKindEach}>
        <p className="text-muted-foreground">{text.stepProgressCounts}</p>
      </Step>
      <Step state="queued" eyebrow={text.stepKindResult} description={text.stepResultText} />
    </Steps>
  );
}

export const stepsGalleryEntry: GalleryEntry = {
  name: "Steps",
  components: ["Steps", "Step"],
  render: (text) => (
    <>
      <Samples label={text.stepsDescribed}>
        <div className="w-full min-w-0">
          <DescribedSteps text={text} />
        </div>
      </Samples>
      <Samples label={text.stepsStates}>
        <div className="w-full min-w-0">
          <StateSteps text={text} />
        </div>
      </Samples>
      <Samples label={text.stepsNarrow}>
        <div className="w-full max-w-80 min-w-0">
          <DescribedSteps text={text} />
        </div>
      </Samples>
    </>
  )
};
