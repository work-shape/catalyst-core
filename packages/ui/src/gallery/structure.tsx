import { ArrowLeft, Download, Maximize2, MessageSquare, Minimize2, Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { EmptyState } from "../feedback/empty-state";
import { DropdownMenuItem } from "../overlays/dropdown-menu";
import { Input } from "../forms/input";
import { Badge } from "../status/badge";
import { RegistryIcon } from "../status/registry-icon";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardPadding
} from "../structure/card";
import { CardReachable, CardTarget } from "../structure/card-target";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  type DisclosureVariant
} from "../structure/disclosure";
import { Page, PageBar, PageFooter, type PageWidth } from "../structure/page";
import { PageHeader, PageHeaderBack, PageHeaderShellAction } from "../structure/page-header";
import { PageLead } from "../structure/page-lead";
import { Section, type SectionLayout } from "../structure/section";
import { SplitHandle } from "../structure/split-handle";
import { SurfaceFrame, SurfaceHeader } from "../structure/surface-frame";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const cardPaddings: readonly CardPadding[] = ["md", "lg"];
const pageWidths: readonly PageWidth[] = ["narrow", "default", "wide"];
const sectionLayouts: readonly SectionLayout[] = ["split", "stacked"];
const disclosureVariants: readonly DisclosureVariant[] = ["ghost", "outline"];

function pageWidthLabel(width: PageWidth, text: GalleryText): string {
  const labels: Record<PageWidth, string> = {
    narrow: text.pageWidthNarrow,
    default: text.pageWidthDefault,
    wide: text.pageWidthWide
  };
  return labels[width];
}

function PageHeaderSamples({ text }: { text: GalleryText }) {
  const actions = {
    scope: <Badge appearance="outline">{text.headerScope}</Badge>,
    state: <Badge>{text.stateDraft}</Badge>,
    secondaryActions: [{ label: text.headerTestRun, onSelect: () => undefined }],
    primaryAction: <Button>{text.publish}</Button>,
    menu: (
      <DropdownMenuItem icon={<Download aria-hidden="true" />}>{text.assetExport}</DropdownMenuItem>
    )
  };
  return (
    <>
      <Samples label={text.headerList}>
        <div className="w-full rounded-lg border px-(--layout-gutter) pt-6">
          <PageHeader
            headingLevel={2}
            title={text.headerListTitle}
            description={text.headerListDescription}
            primaryAction={
              <Button>
                <Plus aria-hidden="true" />
                {text.headerNewAgent}
              </Button>
            }
          />
        </div>
      </Samples>
      <Samples label={text.headerShellAction}>
        <div className="w-full rounded-lg border px-(--layout-gutter) pt-6">
          <PageHeaderShellAction
            action={
              <Button variant="secondary">
                <MessageSquare aria-hidden="true" />
                {text.headerShellChat}
              </Button>
            }
          >
            <PageHeader
              title={text.headerListTitle}
              description={text.headerListDescription}
              primaryAction={
                <Button>
                  <Plus aria-hidden="true" />
                  {text.headerNewAgent}
                </Button>
              }
            />
          </PageHeaderShellAction>
        </div>
      </Samples>
      <Samples label={text.headerDetail}>
        <div
          className="h-48 w-full overflow-y-auto rounded-lg border"
          data-gallery-sample="header-detail"
        >
          <PageHeader
            variant="detail"
            headingLevel={2}
            back={
              <IconButton label={text.headerBack}>
                <ArrowLeft aria-hidden="true" />
              </IconButton>
            }
            title={text.rowAgent}
            {...actions}
          />
          <Page>
            <p className="min-h-64 text-body text-muted-foreground">{text.saveStickyBody}</p>
          </Page>
        </div>
      </Samples>
      <Samples label="detail: PageHeaderBack, description">
        <div className="w-full overflow-hidden rounded-lg border">
          <PageHeader
            variant="detail"
            headingLevel={2}
            className="static border-b-0"
            back={
              <PageHeaderBack label={text.headerBack} onClick={() => undefined}>
                {text.headerBreadcrumbAgents}
              </PageHeaderBack>
            }
            title={text.rowAgent}
            description={text.headerListDescription}
            {...actions}
          />
        </div>
      </Samples>
      <Samples label="detail, narrow: the secondary actions in the … menu">
        <div
          className="w-72 max-w-full overflow-hidden rounded-lg border"
          data-gallery-sample="header-folded"
        >
          <PageHeader
            variant="detail"
            headingLevel={2}
            className="static border-b-0"
            back={
              <PageHeaderBack label={text.headerBack} onClick={() => undefined}>
                {text.headerBreadcrumbAgents}
              </PageHeaderBack>
            }
            title={text.rowAgent}
            {...actions}
            secondaryActions={[
              { label: text.headerTestRun, onSelect: () => undefined },
              { label: text.sectionHistory, onSelect: () => undefined }
            ]}
          />
        </div>
      </Samples>
      <Samples label={text.headerDetailBreadcrumb}>
        <div className="w-full overflow-hidden rounded-lg border">
          <PageHeader
            variant="detail"
            headingLevel={2}
            className="static border-b-0"
            back={
              <span className="text-caption text-muted-foreground">
                {text.headerBreadcrumbBuild} / {text.headerBreadcrumbAgents} /
              </span>
            }
            title={text.rowAgent}
            description={<code className="font-mono">{text.headerIdentifier}</code>}
            {...actions}
          />
        </div>
      </Samples>
    </>
  );
}

function SectionSamples({ text }: { text: GalleryText }) {
  return (
    <>
      {sectionLayouts.map((layout) => (
        <Samples key={layout} label={layout}>
          <div className="w-full">
            <Section
              layout={layout}
              headingLevel={3}
              title={text.sectionOverview}
              description={text.sectionOverviewDescription}
            >
              <Input aria-label={text.name} defaultValue={text.namePlaceholder} />
            </Section>
            <Section
              layout={layout}
              headingLevel={3}
              title={text.sectionSkills}
              description={text.sectionSkillsDescription}
              count={4}
              action={
                <Button variant="outline" size="sm">
                  <Plus aria-hidden="true" />
                  {text.addItem}
                </Button>
              }
            >
              <p className="text-body text-muted-foreground">{text.sectionBody}</p>
            </Section>
            <Section
              layout={layout}
              headingLevel={3}
              title={text.sectionInstructions}
              description={text.sectionInstructionsDescription}
              state={
                <Badge tone="accent" appearance="outline">
                  {text.proposedState}
                </Badge>
              }
            >
              <p className="text-body text-muted-foreground">{text.sectionBody}</p>
            </Section>
          </div>
        </Samples>
      ))}
    </>
  );
}

/**
 * A card that opens as a whole: a click anywhere on it starts the chat, while Edit keeps its own
 * action and the time keeps its tooltip. The line under it says what the last click did.
 */
function OpeningCardSample({ text }: { text: GalleryText }) {
  const titleId = useId();
  const [done, setDone] = useState<string>();
  return (
    <div className="grid content-start gap-2" data-gallery-sample="card-target">
      <Card padding="md" className="flex flex-col">
        <CardHeader>
          <CardTitle id={titleId}>{text.cardTitle}</CardTitle>
          <p className="text-body text-muted-foreground">{text.cardBody}</p>
          <p className="text-caption text-muted-foreground">
            <CardReachable>
              <time dateTime="2026-10-13T09:12" title={text.cardChangedAt}>
                {text.cardChanged}
              </time>
            </CardReachable>
          </p>
        </CardHeader>
        <CardFooter>
          <CardTarget label={text.cardActionNamed}>
            <Button size="sm" onClick={() => setDone(text.cardStarted)}>
              {text.cardAction}
            </Button>
          </CardTarget>
          <Button
            size="sm"
            variant="link"
            className="ml-auto"
            aria-describedby={titleId}
            onClick={() => setDone(text.cardEditOpened)}
          >
            {text.cardEdit}
          </Button>
        </CardFooter>
      </Card>
      <p role="status" className="text-caption text-muted-foreground">
        {done}
      </p>
    </div>
  );
}

function SurfaceFrameSamples({ text }: { text: GalleryText }) {
  const showChat = (
    <Button variant="ghost" size="sm">
      <MessageSquare aria-hidden="true" />
      {text.surfaceShowChat}
    </Button>
  );
  const close = (
    <IconButton label={text.surfaceClose}>
      <X aria-hidden="true" />
    </IconButton>
  );
  return (
    <>
      <Samples label={text.surfaceBeside}>
        <div className="h-56 w-full overflow-hidden rounded-lg border">
          <SurfaceFrame
            icon={<RegistryIcon name="spreadsheet" family="file" className="size-5" />}
            title={text.surfaceTitle}
            subtitle={text.surfaceSubtitle}
            actions={
              <Button variant="outline" size="sm">
                <Download aria-hidden="true" />
                {text.surfaceDownload}
              </Button>
            }
            fullscreen={
              <IconButton label={text.surfaceViewFullscreen}>
                <Maximize2 aria-hidden="true" />
              </IconButton>
            }
            close={close}
          >
            <p className="text-body text-muted-foreground">{text.surfaceBody}</p>
          </SurfaceFrame>
        </div>
      </Samples>
      <Samples label={text.surfaceFullscreen}>
        <div className="h-56 w-full overflow-hidden rounded-lg border">
          <SurfaceFrame
            leading={showChat}
            title={text.surfaceTitle}
            subtitle={text.surfaceSubtitle}
            fullscreen={
              <IconButton label={text.surfaceExitFullscreen}>
                <Minimize2 aria-hidden="true" />
              </IconButton>
            }
            close={close}
          >
            <p className="text-body text-muted-foreground">{text.surfaceBody}</p>
          </SurfaceFrame>
        </div>
      </Samples>
      <Samples label={text.surfaceFlush}>
        <div className="h-56 w-full overflow-hidden rounded-lg border">
          <SurfaceFrame
            title={text.surfaceTitle}
            subtitle={text.surfaceSubtitle}
            close={close}
            flush
          >
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1 bg-card p-4 text-body text-muted-foreground">
                {text.surfaceFlushBody}
              </div>
              <p className="border-t px-4 py-2 text-caption text-muted-foreground">
                {text.surfaceFlushFoot}
              </p>
            </div>
          </SurfaceFrame>
        </div>
      </Samples>
      <Samples label={text.surfaceCovering}>
        <div className="h-56 w-full max-w-md overflow-hidden rounded-lg border">
          <SurfaceFrame leading={showChat} title={text.surfaceTitle}>
            <EmptyState layout="inline">{text.surfaceNoRenderer}</EmptyState>
          </SurfaceFrame>
        </div>
      </Samples>
      <Samples label={text.surfaceHeaderAlone}>
        <div
          className="w-full max-w-md overflow-hidden rounded-lg border"
          data-gallery-sample="surface-short-title"
        >
          <SurfaceHeader title={text.surfaceHeaderTitle} close={close} />
        </div>
        <div
          className="w-full max-w-md overflow-hidden rounded-lg border"
          data-gallery-sample="surface-long-title"
        >
          <SurfaceHeader title={text.surfaceHeaderLongTitle} close={close} />
        </div>
      </Samples>
    </>
  );
}

/** A panel at the left whose width the handle at its right edge sets. */
function SplitHandleSample({ text }: { text: GalleryText }) {
  const [width, setWidth] = useState(200);
  return (
    <div className="flex h-32 w-full overflow-hidden rounded-lg border" data-gallery-sample="split">
      <div className="relative shrink-0 border-r bg-muted" style={{ width: `${width}px` }}>
        <p className="p-3 text-caption text-muted-foreground">{text.splitHandleSample}</p>
        <SplitHandle
          label={text.splitHandleLabel}
          edge="right"
          width={width}
          min={120}
          max={360}
          onResize={setWidth}
        />
      </div>
      <div className="min-w-0 flex-1" />
    </div>
  );
}

export const structureGallery: GalleryGroup = {
  id: "structure",
  entries: [
    {
      name: "Page",
      components: ["Page", "PageFooter", "PageBar"],
      render: (text) => (
        <div className="grid gap-3">
          {/* A page that scrolls ends with the page-end space; with a footer the space is above it. */}
          <div className="h-56 overflow-y-auto rounded-lg border" data-gallery-sample="page-footer">
            <Page width="narrow">
              <PageBar className="text-caption text-muted-foreground">{text.pageBarPinned}</PageBar>
              <p className="min-h-64 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
                {pageWidthLabel("narrow", text)}
              </p>
              <PageFooter className="py-3">
                <Button>{text.saveChanges}</Button>
              </PageFooter>
            </Page>
          </div>
          {pageWidths.map((width) => (
            <div key={width} className="rounded-lg border" data-gallery-sample={`page-${width}`}>
              <Page width={width}>
                <p className="rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
                  {pageWidthLabel(width, text)}
                </p>
              </Page>
            </div>
          ))}
        </div>
      )
    },
    {
      name: "PageHeader",
      components: ["PageHeader", "PageHeaderBack", "PageHeaderShellAction"],
      render: (text) => <PageHeaderSamples text={text} />
    },
    {
      name: "PageLead",
      components: ["PageLead"],
      render: (text) => (
        <div className="grid gap-3">
          {/* One sentence stands whole; a text of more than two lines ends in "Show more". */}
          <div className="rounded-lg border pb-3" data-gallery-sample="page-lead-short">
            <PageLead>{text.cardBody}</PageLead>
          </div>
          <div className="max-w-md rounded-lg border pb-3" data-gallery-sample="page-lead-long">
            <PageLead>{Array.from({ length: 6 }, () => text.cardBody).join(" ")}</PageLead>
          </div>
        </div>
      )
    },
    {
      name: "Section",
      components: ["Section"],
      render: (text) => <SectionSamples text={text} />
    },
    {
      name: "SurfaceFrame",
      components: ["SurfaceFrame", "SurfaceHeader"],
      render: (text) => <SurfaceFrameSamples text={text} />
    },
    {
      name: "SplitHandle",
      components: ["SplitHandle"],
      render: (text) => <SplitHandleSample text={text} />
    },
    {
      name: "Card",
      components: [
        "Card",
        "CardHeader",
        "CardTitle",
        "CardContent",
        "CardFooter",
        "CardTarget",
        "CardReachable"
      ],
      render: (text) => (
        <div className="grid gap-4 sm:grid-cols-2">
          {cardPaddings.map((padding) => (
            <Card key={padding} padding={padding}>
              <CardHeader>
                <CardTitle>{text.cardTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-body text-muted-foreground">{text.cardBody}</p>
              </CardContent>
            </Card>
          ))}
          {/* Side by side the cards are equally tall, and their actions share the lower edge. */}
          {[text.cardBody, text.cardBodyLong].map((body) => (
            <Card key={body} padding="md" className="flex flex-col">
              <CardHeader>
                <CardTitle>{text.cardTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-body text-muted-foreground">{body}</p>
              </CardContent>
              <CardFooter>
                <Button size="sm">{text.cardAction}</Button>
              </CardFooter>
            </Card>
          ))}
          <OpeningCardSample text={text} />
        </div>
      )
    },
    {
      name: "Disclosure",
      components: ["Disclosure", "DisclosureTrigger", "DisclosureContent"],
      render: (text) => (
        <>
          {disclosureVariants.map((variant) => (
            <Samples key={variant} label={variant}>
              <div className="grid w-full max-w-md gap-3">
                <Disclosure variant={variant}>
                  <DisclosureTrigger>{text.disclosureAdvanced}</DisclosureTrigger>
                  <DisclosureContent>
                    <p className="text-muted-foreground">{text.disclosureAdvancedBody}</p>
                  </DisclosureContent>
                </Disclosure>
                <Disclosure variant={variant} defaultOpen>
                  <DisclosureTrigger>{text.disclosureErrors}</DisclosureTrigger>
                  <DisclosureContent>
                    <p className="text-muted-foreground">{text.disclosureErrorOne}</p>
                    <p className="text-muted-foreground">{text.disclosureErrorTwo}</p>
                  </DisclosureContent>
                </Disclosure>
                <Disclosure variant={variant}>
                  <DisclosureTrigger>{text.disclosureKeptMounted}</DisclosureTrigger>
                  <DisclosureContent keepMounted data-gallery-kept-mounted="">
                    <p className="text-muted-foreground">{text.disclosureKeptMountedBody}</p>
                  </DisclosureContent>
                </Disclosure>
                <Disclosure variant={variant} disabled>
                  <DisclosureTrigger>{text.disabled}</DisclosureTrigger>
                  <DisclosureContent>{text.disclosureAdvancedBody}</DisclosureContent>
                </Disclosure>
              </div>
            </Samples>
          ))}
        </>
      )
    }
  ]
};
