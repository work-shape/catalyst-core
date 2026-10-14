import { Bot, CalendarClock, Clock, LayoutGrid, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { Banner, type BannerTone } from "../feedback/banner";
import { EmptyState } from "../feedback/empty-state";
import { FormNotice } from "../feedback/form-notice";
import { InlineError } from "../feedback/inline-error";
import { Progress } from "../feedback/progress";
import { Skeleton, SkeletonChips, SkeletonList, SkeletonPage } from "../feedback/skeleton";
import { Spinner, type SpinnerSize } from "../feedback/spinner";
import { Chip } from "../status/chip";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const spinnerSizes: readonly SpinnerSize[] = ["xs", "sm", "md", "lg"];
const bannerTones: readonly BannerTone[] = ["info", "success", "warning", "danger"];

function bannerText(tone: BannerTone, text: GalleryText): string {
  const texts: Record<BannerTone, string> = {
    info: text.bannerInfo,
    success: text.bannerSuccess,
    warning: text.bannerWarning,
    danger: text.bannerDanger
  };
  return texts[tone];
}

function BannerSamples({ text }: { text: GalleryText }) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <div className="grid gap-3">
      {bannerTones.map((tone) => (
        <Banner key={tone} tone={tone}>
          {bannerText(tone, text)}
        </Banner>
      ))}
      {dismissed ? (
        <Samples>
          <Button variant="ghost" size="sm" onClick={() => setDismissed(false)}>
            {text.showAgain}
          </Button>
        </Samples>
      ) : (
        <Banner
          tone="warning"
          title={text.bannerWarningTitle}
          action={
            <Button variant="outline" size="sm">
              {text.bannerAction}
            </Button>
          }
          onDismiss={() => setDismissed(true)}
        >
          {text.bannerWarning}
        </Banner>
      )}
      <Banner tone="success" icon={null}>
        {text.bannerSuccess}
      </Banner>
      <Banner layout="page" tone="info">
        {text.bannerPage}
      </Banner>
      <Banner layout="line" tone="warning" icon={<Clock aria-hidden="true" />}>
        {text.bannerLine}
      </Banner>
    </div>
  );
}

export const feedbackGallery: GalleryGroup = {
  id: "feedback",
  entries: [
    {
      name: "Spinner",
      components: ["Spinner"],
      render: () => (
        <Samples>
          {spinnerSizes.map((size) => (
            <Spinner key={size} size={size} />
          ))}
        </Samples>
      )
    },
    {
      name: "InlineError",
      components: ["InlineError"],
      render: (text) => <InlineError className="max-w-sm">{text.errorMessage}</InlineError>
    },
    {
      name: "Banner",
      components: ["Banner"],
      render: (text) => <BannerSamples text={text} />
    },
    {
      name: "FormNotice",
      components: ["FormNotice"],
      render: (text) => (
        <>
          <Samples>
            <Button>{text.save}</Button>
            <FormNotice tone="success">{text.noticeSaved}</FormNotice>
          </Samples>
          <Samples>
            <Button variant="outline">{text.bannerAction}</Button>
            <FormNotice tone="error">{text.noticeFailed}</FormNotice>
          </Samples>
        </>
      )
    },
    {
      name: "EmptyState",
      components: ["EmptyState"],
      render: (text) => (
        <>
          <Samples label={text.layoutPage}>
            <EmptyState
              className="w-full"
              icon={<Bot aria-hidden="true" />}
              action={
                <Button>
                  <Plus aria-hidden="true" />
                  {text.emptyAgentsAction}
                </Button>
              }
              presets={
                <>
                  <Chip onClick={() => undefined}>{text.emptyPresetBriefing}</Chip>
                  <Chip onClick={() => undefined}>{text.emptyPresetReview}</Chip>
                  <Chip onClick={() => undefined}>{text.emptyPresetTriage}</Chip>
                </>
              }
            >
              {text.emptyAgents}
            </EmptyState>
          </Samples>
          <Samples label={text.layoutInline}>
            <EmptyState
              layout="inline"
              icon={<CalendarClock aria-hidden="true" />}
              action={
                <Button variant="outline" size="sm">
                  {text.addItem}
                </Button>
              }
            >
              {text.emptyInline}
            </EmptyState>
          </Samples>
          <Samples label={text.layoutNoRight}>
            <EmptyState className="w-full" icon={<LayoutGrid aria-hidden="true" />}>
              {text.emptyNoRight}
            </EmptyState>
          </Samples>
        </>
      )
    },
    {
      name: "Progress",
      components: ["Progress"],
      render: (text) => (
        <>
          <Samples label={text.progressTones}>
            <Progress label={text.progressStorage} value={4} valueLabel={text.progressStorageLow} />
            <Progress
              label={text.progressStorage}
              value={84}
              tone="warning"
              valueLabel={text.progressStorageHigh}
            />
            <Progress
              label={text.progressStorage}
              value={5}
              max={5}
              tone="danger"
              valueLabel={text.progressStorageFull}
            />
          </Samples>
          <Samples label={text.progressSmall}>
            <Progress size="sm" label={text.progressEntries} value={212} max={600} tone="success" />
          </Samples>
          <Samples label={text.progressParts}>
            <Progress
              label={text.progressEntries}
              max={600}
              parts={[
                { value: 210, tone: "success" },
                { value: 2, tone: "danger" }
              ]}
              valueLabel={text.progressEntriesEarly}
            />
            <Progress
              label={text.progressEntries}
              max={600}
              parts={[
                { value: 478, tone: "success" },
                { value: 120, tone: "danger" }
              ]}
              valueLabel={text.progressEntriesLate}
            />
          </Samples>
          <Samples label={text.progressUnknown}>
            <Progress label={text.progressWorking} />
            <Progress size="sm" label={text.progressWorking} tone="success" />
          </Samples>
          <Samples label={text.progressNarrow}>
            <Progress
              className="max-w-64"
              label={text.progressEntries}
              value={1284}
              max={12000}
              valueLabel={text.progressEntriesLong}
            />
          </Samples>
        </>
      )
    },
    {
      name: "Skeleton",
      components: ["Skeleton", "SkeletonChips", "SkeletonList", "SkeletonPage"],
      render: (text) => (
        <>
          <Samples label={text.skeletonShapes}>
            <Skeleton shape="circle" />
            <Skeleton className="w-40" />
            <Skeleton shape="block" className="w-40" />
          </Samples>
          <Samples label={text.skeletonList}>
            <SkeletonList className="w-full max-w-md" rows={3} />
            <SkeletonChips className="w-full max-w-md" />
          </Samples>
          <Samples label={text.skeletonPage}>
            <SkeletonPage className="w-full max-w-md" />
          </Samples>
        </>
      )
    }
  ]
};
