import {
  ArrowLeft,
  Download,
  Ellipsis,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  X
} from "lucide-react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { EmptyState } from "../feedback/empty-state";
import { Input } from "../forms/input";
import { Badge } from "../status/badge";
import { Card, CardContent, CardHeader, CardTitle, type CardPadding } from "../structure/card";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  type DisclosureVariant
} from "../structure/disclosure";
import { Page, type PageWidth } from "../structure/page";
import { PageHeader } from "../structure/page-header";
import { Section, type SectionLayout } from "../structure/section";
import { SurfaceFrame } from "../structure/surface-frame";
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
    secondaryActions: <Button variant="outline">{text.headerTestRun}</Button>,
    primaryAction: <Button>{text.publish}</Button>,
    overflow: (
      <IconButton label={text.moreActions}>
        <Ellipsis aria-hidden="true" />
      </IconButton>
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
      <Samples label={text.headerDetail}>
        <div
          className="h-48 w-full overflow-y-auto rounded-lg border [scrollbar-width:thin]"
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
          </div>
        </Samples>
      ))}
    </>
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
      <Samples label={text.surfaceCovering}>
        <div className="h-56 w-full max-w-md overflow-hidden rounded-lg border">
          <SurfaceFrame leading={showChat} title={text.surfaceTitle}>
            <EmptyState layout="inline">{text.surfaceNoRenderer}</EmptyState>
          </SurfaceFrame>
        </div>
      </Samples>
    </>
  );
}

export const structureGallery: GalleryGroup = {
  id: "structure",
  entries: [
    {
      name: "Page",
      components: ["Page"],
      render: (text) => (
        <div className="grid gap-3">
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
      components: ["PageHeader"],
      render: (text) => <PageHeaderSamples text={text} />
    },
    {
      name: "Section",
      components: ["Section"],
      render: (text) => <SectionSamples text={text} />
    },
    {
      name: "SurfaceFrame",
      components: ["SurfaceFrame"],
      render: (text) => <SurfaceFrameSamples text={text} />
    },
    {
      name: "Card",
      components: ["Card", "CardHeader", "CardTitle", "CardContent"],
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
