import { useRef, useState, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { uiLabelsDe, uiLabelsEn } from "../labels";
import { SubRail, type SubRailGroup } from "../navigation/sub-rail";
import { Page } from "../structure/page";
import { DEFAULT_THEME_INPUTS, type ThemeMode } from "../theme";
import { UiRoot } from "../ui-root";
import type { GalleryGroup, GalleryGroupId } from "./entry";
import { galleryGroups } from "./groups";
import { samplePages } from "./samples";
import { galleryText, type GalleryLanguage, type GalleryText } from "./text";

export { galleryGroups } from "./groups";
export type { GalleryEntry, GalleryGroup, GalleryGroupId } from "./entry";
export type { GalleryLanguage } from "./text";

/** What the gallery's rail opens: the sample pages, then one page per component group. */
export type GallerySectionId = "samples" | GalleryGroupId;

type GalleryModeChoice = ThemeMode | "both";

export interface UiGalleryProps {
  /** The mode the gallery opens in. The reader switches it without touching the application. */
  initialMode: ThemeMode;
  /** The language the gallery opens in. Any language other than German opens it in English. */
  initialLanguage: string;
  /** The section the gallery opens in. Without it the gallery opens on the sample pages. */
  initialSection?: GallerySectionId;
}

const modeChoices: readonly GalleryModeChoice[] = ["light", "dark", "both"];
const languageChoices: readonly GalleryLanguage[] = ["de", "en"];

/**
 * The gallery of the shared UI library: three sample pages and every component in every
 * variant, size and state, in either mode and either language, under the base theme. It is the
 * visual check of the library and shows fixed sample data only.
 */
export function UiGallery({ initialMode, initialLanguage, initialSection }: UiGalleryProps) {
  const [mode, setMode] = useState<GalleryModeChoice>(initialMode);
  const [language, setLanguage] = useState<GalleryLanguage>(initialLanguage === "de" ? "de" : "en");
  const [section, setSection] = useState<GallerySectionId>(initialSection ?? "samples");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const text = galleryText[language];
  const labels = language === "de" ? uiLabelsDe : uiLabelsEn;
  const panels: readonly ThemeMode[] = mode === "both" ? ["light", "dark"] : [mode];
  // The gallery's own frame shows the chosen mode. Side by side it keeps the application's.
  const frameMode = mode === "both" ? initialMode : mode;
  const group = galleryGroups.find((candidate) => candidate.id === section);
  const openSection = (id: string) => {
    setSection(toSection(id, section));
    scrollerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  };

  return (
    <UiRoot
      data-ui-gallery=""
      lang={language}
      theme={DEFAULT_THEME_INPUTS[frameMode]}
      mode={frameMode}
      labels={labels}
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-(--layout-gutter) py-3">
        <h1 className="text-title">{text.title}</h1>
        <Choice label={text.mode}>
          {modeChoices.map((choice) => (
            <ChoiceButton key={choice} selected={choice === mode} onSelect={() => setMode(choice)}>
              {modeLabel(choice, text)}
            </ChoiceButton>
          ))}
        </Choice>
        <Choice label={text.language}>
          {languageChoices.map((choice) => (
            <ChoiceButton
              key={choice}
              selected={choice === language}
              onSelect={() => setLanguage(choice)}
            >
              {choice.toUpperCase()}
            </ChoiceButton>
          ))}
        </Choice>
      </header>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <Page
          width="wide"
          subRail={
            <SubRail
              mode="routes"
              label={text.sections}
              groups={sectionGroups(text)}
              value={section}
              onValueChange={openSection}
            />
          }
        >
          <div data-gallery-section={section} className="@container grid min-w-0 gap-8">
            {group ? (
              <GroupSection group={group} panels={panels} language={language} text={text} />
            ) : (
              <SampleSection panels={panels} language={language} text={text} />
            )}
          </div>
        </Page>
      </div>
    </UiRoot>
  );
}

interface SectionProps {
  panels: readonly ThemeMode[];
  language: GalleryLanguage;
  text: GalleryText;
}

/** One component group: every entry of the group, once per panel. */
function GroupSection({ group, panels, language, text }: SectionProps & { group: GalleryGroup }) {
  const several = panels.length > 1;
  return (
    <section data-gallery-group={group.id} className="grid min-w-0 gap-4">
      <h2 className="text-title-sm">{groupLabel(group.id, text)}</h2>
      <div className={cn("grid min-w-0 gap-(--layout-gutter)", several && "@6xl:grid-cols-2")}>
        {panels.map((panel) => (
          <PanelRoot
            key={panel}
            mode={panel}
            language={language}
            className={cn("grid min-w-0 content-start gap-4", several && "rounded-lg border p-4")}
          >
            {group.entries.length === 0 ? (
              <p className="text-body text-muted-foreground">{text.emptyGroup}</p>
            ) : (
              group.entries.map((entry) => (
                <article
                  key={entry.name}
                  data-gallery-entry={entry.name}
                  className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 text-card-foreground"
                >
                  <h3 className="text-heading">{entry.heading?.(text) ?? entry.name}</h3>
                  {entry.render(text)}
                </article>
              ))
            )}
          </PanelRoot>
        ))}
      </div>
    </section>
  );
}

/**
 * The sample pages, each in a frame the size of a small window, once per panel. The frame
 * scrolls by itself, so a sticky header, section index and save bar hold their place as they
 * do on a real page.
 */
function SampleSection({ panels, language, text }: SectionProps) {
  const several = panels.length > 1;
  return (
    <>
      <div className="grid min-w-0 gap-2">
        <h2 className="text-title-sm">{text.sectionSamples}</h2>
        <p className="max-w-(--layout-content-narrow) text-body text-muted-foreground">
          {text.sampleNote}
        </p>
      </div>
      {samplePages.map((sample) => (
        <section key={sample.id} data-gallery-sample={sample.id} className="grid min-w-0 gap-3">
          <h3 className="text-heading">{sample.title(text)}</h3>
          <div
            className={cn("grid min-w-0 gap-(--layout-gutter)", several && "@[110rem]:grid-cols-2")}
          >
            {panels.map((panel) => (
              <div key={panel} className="grid min-w-0 gap-2">
                {several ? (
                  <p className="text-caption font-medium text-muted-foreground">
                    {modeLabel(panel, text)}
                  </p>
                ) : null}
                <PanelRoot
                  mode={panel}
                  language={language}
                  className="max-h-160 overflow-y-auto rounded-lg border [scrollbar-width:thin]"
                >
                  {sample.render(text)}
                </PanelRoot>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** A themed root of its own, so a panel shows its mode whatever is around it. */
function PanelRoot({
  mode,
  language,
  className,
  children
}: {
  mode: ThemeMode;
  language: GalleryLanguage;
  className?: string;
  children: ReactNode;
}) {
  return (
    <UiRoot
      data-gallery-mode={mode}
      lang={language}
      theme={DEFAULT_THEME_INPUTS[mode]}
      mode={mode}
      labels={language === "de" ? uiLabelsDe : uiLabelsEn}
      className={cn("bg-background text-foreground", className)}
    >
      {children}
    </UiRoot>
  );
}

function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <span className="mr-1 text-caption text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ChoiceButton({
  selected,
  onSelect,
  children
}: {
  selected: boolean;
  onSelect(): void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}

function sectionGroups(text: GalleryText): SubRailGroup[] {
  return [
    {
      id: "review",
      label: text.sectionsReview,
      items: [{ id: "samples", label: text.sectionSamples }]
    },
    {
      id: "components",
      label: text.groups,
      items: galleryGroups.map((group) => ({ id: group.id, label: groupLabel(group.id, text) }))
    }
  ];
}

function toSection(id: string, fallback: GallerySectionId): GallerySectionId {
  const sections: readonly GallerySectionId[] = [
    "samples",
    ...galleryGroups.map((group) => group.id)
  ];
  return sections.find((candidate) => candidate === id) ?? fallback;
}

function modeLabel(mode: GalleryModeChoice, text: GalleryText): string {
  const labels: Record<GalleryModeChoice, string> = {
    light: text.modeLight,
    dark: text.modeDark,
    both: text.modeBoth
  };
  return labels[mode];
}

function groupLabel(group: GalleryGroupId, text: GalleryText): string {
  const labels: Record<GalleryGroupId, string> = {
    foundations: text.groupFoundations,
    actions: text.groupActions,
    forms: text.groupForms,
    overlays: text.groupOverlays,
    navigation: text.groupNavigation,
    structure: text.groupStructure,
    data: text.groupData,
    status: text.groupStatus,
    feedback: text.groupFeedback
  };
  return labels[group];
}
