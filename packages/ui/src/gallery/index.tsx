import { useState, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { uiLabelsDe, uiLabelsEn } from "../labels";
import type { ThemeMode } from "../theme";
import { UiRoot } from "../ui-root";
import type { GalleryGroupId } from "./entry";
import { galleryGroups } from "./groups";
import { galleryThemes, type GalleryThemeId } from "./sample-themes";
import { galleryText, type GalleryLanguage, type GalleryText } from "./text";

export { galleryGroups } from "./groups";
export type { GalleryEntry, GalleryGroup, GalleryGroupId } from "./entry";
export type { GalleryLanguage } from "./text";

type GalleryModeChoice = ThemeMode | "both";

export interface UiGalleryProps {
  /** The mode the gallery opens in. The reader switches it without touching the application. */
  initialMode: ThemeMode;
  /** The language the gallery opens in. Any language other than German opens it in English. */
  initialLanguage: string;
}

const modeChoices: readonly GalleryModeChoice[] = ["light", "dark", "both"];
const languageChoices: readonly GalleryLanguage[] = ["de", "en"];
const themeChoices: readonly GalleryThemeId[] = ["default", "teal", "previous"];

/**
 * The gallery of the shared UI library: every component in every variant, size and state, in
 * either mode, either language and each sample theme. It is the visual check of the library
 * and shows fixed sample data only.
 */
export function UiGallery({ initialMode, initialLanguage }: UiGalleryProps) {
  const [mode, setMode] = useState<GalleryModeChoice>(initialMode);
  const [language, setLanguage] = useState<GalleryLanguage>(initialLanguage === "de" ? "de" : "en");
  const [themeId, setThemeId] = useState<GalleryThemeId>("default");
  const text = galleryText[language];
  const modes: readonly ThemeMode[] = mode === "both" ? ["light", "dark"] : [mode];

  return (
    <div data-ui-gallery="" className="flex h-full min-h-0 w-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-(--layout-gutter) py-3">
        <h1 className="text-title">{text.title}</h1>
        <Choice label={text.theme}>
          {themeChoices.map((choice) => (
            <ChoiceButton
              key={choice}
              selected={choice === themeId}
              onSelect={() => setThemeId(choice)}
            >
              {themeLabel(choice, text)}
            </ChoiceButton>
          ))}
        </Choice>
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
      <div
        className={cn(
          "grid min-h-0 flex-1 overflow-y-auto",
          modes.length === 2 && "lg:grid-cols-2"
        )}
      >
        {modes.map((panelMode) => (
          <UiRoot
            key={panelMode}
            data-gallery-mode={panelMode}
            data-gallery-theme={themeId}
            lang={language}
            theme={galleryThemes[themeId][panelMode]}
            mode={panelMode}
            labels={language === "de" ? uiLabelsDe : uiLabelsEn}
            className="min-w-0 bg-background px-(--layout-gutter) py-6 text-foreground"
          >
            <GalleryGroups text={text} />
          </UiRoot>
        ))}
      </div>
    </div>
  );
}

function GalleryGroups({ text }: { text: GalleryText }) {
  return (
    <div className="mx-auto grid w-full max-w-(--layout-content) gap-10">
      {galleryGroups.map((group) => (
        <section key={group.id} data-gallery-group={group.id} className="grid gap-4">
          <h2 className="text-title-sm">{groupLabel(group.id, text)}</h2>
          {group.entries.length === 0 ? (
            <p className="text-body text-muted-foreground">{text.emptyGroup}</p>
          ) : (
            group.entries.map((entry) => (
              <article
                key={entry.name}
                data-gallery-entry={entry.name}
                className="grid gap-4 rounded-lg border bg-card p-4 text-card-foreground"
              >
                <h3 className="text-heading">{entry.heading?.(text) ?? entry.name}</h3>
                {entry.render(text)}
              </article>
            ))
          )}
        </section>
      ))}
    </div>
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

function themeLabel(theme: GalleryThemeId, text: GalleryText): string {
  const labels: Record<GalleryThemeId, string> = {
    default: text.themeDefault,
    teal: text.themeTeal,
    previous: text.themePrevious
  };
  return labels[theme];
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
