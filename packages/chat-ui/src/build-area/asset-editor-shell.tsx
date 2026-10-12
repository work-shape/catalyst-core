import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Banner,
  FormNotice,
  KeyValue,
  KeyValueList,
  Page,
  PageFooter,
  PageHeader,
  SaveBar,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  SubRail
} from "@vivd-catalyst/ui";
import { DocsReference } from "../docs-links";
import { useTranslation } from "../i18n";
import { AssetLanguageProvider } from "./asset-form-fields";
import { ASSET_LANGUAGES, type LocalizedPair } from "./asset-form-model";
import type { BuildAssetEditorProps, BuildPageSlot } from "./build-asset-kind";
import { refusalsOf, type BuildRefusalField, type BuildWriteOutcome } from "./build-refusals";
import { scrollToSection } from "./build-scroll";

type AssetLanguage = keyof LocalizedPair;

/** One section of an asset page: an entry of the index and the fields under its heading. */
export interface AssetSection {
  /** The anchor the index scrolls to. */
  id: string;
  label: string;
  description?: string;
  /** How many things the section holds, in the index and after the heading. */
  count?: number;
  /** The field a refusal names that belongs here: a refused save scrolls to this section. */
  refusalField?: BuildRefusalField;
  body: ReactNode;
}

/**
 * The form a kind's page holds, as the shell needs it: the shell counts the changes, saves,
 * discards and tells the frame about unsaved changes, whatever the form is made of.
 */
export interface AssetFormControl {
  /** How many fields differ from what was loaded or last saved. */
  changes: number;
  /** The definition to save, made from the form. */
  submit(): Promise<BuildWriteOutcome>;
  discard(): void;
}

/** The form state every kind's page keeps the same way: the form, what it started as, and the last answer. */
export function useAssetForm<Form>(initial: Form): {
  form: Form;
  setForm(next: Form | ((form: Form) => Form)): void;
  /** What the form is compared with: as loaded, or as last saved. */
  baseline: Form;
  markSaved(): void;
  discard(): void;
  outcome: BuildWriteOutcome | undefined;
  setOutcome(outcome: BuildWriteOutcome | undefined): void;
} {
  const [form, setForm] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [outcome, setOutcome] = useState<BuildWriteOutcome>();
  return {
    form,
    setForm,
    baseline,
    markSaved: () => setBaseline(form),
    discard: () => {
      setForm(baseline);
      setOutcome(undefined);
    },
    outcome,
    setOutcome
  };
}

/**
 * Tells the frame that the page shows something new, so the focus can move to its heading.
 * `what` names what shows: the frame hears of every change of it.
 */
export function usePageShown(page: BuildPageSlot, what: string): void {
  const { shown } = page;
  useEffect(() => {
    shown();
  }, [shown, what]);
}

/**
 * An asset's technical id, read-only and with a copy button: the first thing in the first
 * section of its page. The head is one row and names the asset only.
 */
export function AssetIdentifier({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <KeyValueList layout="stacked" data-asset-identifier="">
      <KeyValue label={t("build.identifier")} copyValue={name}>
        <code className="font-mono text-code break-all">{name}</code>
      </KeyValue>
    </KeyValueList>
  );
}

/**
 * The page of one asset, the same for every kind: the head with the way back and the name,
 * the id at the top of the first section, the index of the sections, the one language switch, what a refused save says, and
 * the save bar that shows with the first change. A kind hands it its sections.
 */
export function AssetEditorShell({
  frame,
  title,
  badges,
  headActions,
  sections,
  missingTranslations,
  control,
  outcome,
  saving,
  saveLabel
}: {
  /** What the frame handed the kind's page. */
  frame: BuildAssetEditorProps;
  title: string;
  badges?: ReactNode;
  /** Actions of the kind before the frame's own, such as making an agent the default. */
  headActions?: ReactNode;
  sections: readonly AssetSection[];
  /** With it the page has texts per language: how many are still empty in each one. */
  missingTranslations?: LocalizedPair<number>;
  control: AssetFormControl;
  /** The answer to the last save. Its refusals show at their fields and above the save bar. */
  outcome: BuildWriteOutcome | undefined;
  saving: boolean;
  saveLabel: string;
}) {
  const { locale, t } = useTranslation();
  const { page, back, actions, notice, canWrite, asset, start, onUnsavedChange } = frame;
  const { readOnlyReason, saveBlocked = false } = frame;
  const [language, setLanguage] = useState<AssetLanguage>(locale === "de" ? "de" : "en");
  const isNew = asset === undefined;
  usePageShown(page, "asset");
  const dirty = isNew || control.changes > 0;
  const unsaved = canWrite && dirty;

  useEffect(() => {
    onUnsavedChange(unsaved);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);

  const formRef = useRef<HTMLFormElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const hasNotice = Boolean(notice);
  // A notice that appears is shown: where the footer rests at the end of the page it may be
  // below the window.
  useEffect(() => {
    if (hasNotice) footerRef.current?.scrollIntoView({ block: "nearest" });
  }, [hasNotice]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    control.submit().then(
      (answer) => {
        // A refusal that names a field is read where the field is.
        const named = sections.find(
          (section) => section.refusalField && refusalsOf(answer, section.refusalField).length > 0
        );
        if (named) {
          scrollToSection(formRef.current, named.id);
        }
      },
      () => undefined
    );
  };
  const identifier = asset?.name ?? start?.name ?? "";
  const general = refusalsOf(outcome, undefined);

  return (
    <Page
      ref={page.ref}
      header={
        <PageHeader
          variant="detail"
          back={back}
          title={title}
          state={badges}
          secondaryActions={
            <>
              {headActions}
              {actions}
            </>
          }
        />
      }
      subRail={
        sections.length > 1 ? (
          <SubRail
            mode="anchors"
            belowHeader
            label={t("build.sections")}
            groups={[
              {
                id: "sections",
                items: sections.map((section) => ({
                  id: section.id,
                  label: section.label,
                  count: section.count
                }))
              }
            ]}
          />
        ) : undefined
      }
    >
      {page.above}
      <form
        ref={formRef}
        // The first line of the content starts where the first item of the index does.
        className="grid min-w-0 content-start pt-5"
        noValidate={!canWrite}
        onSubmit={submit}
      >
        {canWrite ? null : (
          <Banner tone="info" className="mb-3" data-build-read-only="">
            {readOnlyReason ?? t("build.readOnly")} <DocsReference to="buildReadOnly" />
          </Banner>
        )}
        {missingTranslations ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-label text-muted-foreground">{t("build.textsIn")}</span>
            <SegmentedControl
              size="sm"
              label={t("build.textsIn")}
              value={language}
              onValueChange={(next) =>
                setLanguage(ASSET_LANGUAGES.find((candidate) => candidate === next) ?? language)
              }
            >
              {ASSET_LANGUAGES.map((candidate) => (
                <SegmentedControlItem
                  key={candidate}
                  value={candidate}
                  count={
                    candidate !== language && missingTranslations[candidate] > 0
                      ? missingTranslations[candidate]
                      : undefined
                  }
                  title={
                    missingTranslations[candidate] > 0
                      ? t(
                          missingTranslations[candidate] === 1
                            ? "build.textMissing"
                            : "build.textsMissing",
                          { count: missingTranslations[candidate] }
                        )
                      : undefined
                  }
                >
                  {t(candidate === "en" ? "configEnglishLanguage" : "configGermanLanguage")}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        ) : null}
        <AssetLanguageProvider value={language}>
          {sections.map((section, index) => (
            <Section
              key={section.id}
              id={section.id}
              title={section.label}
              description={section.description}
              count={section.count}
            >
              {index === 0 && identifier ? <AssetIdentifier name={identifier} /> : null}
              {section.body}
            </Section>
          ))}
        </AssetLanguageProvider>
        {notice || general.length > 0 || (canWrite && (dirty || saving)) ? (
          <PageFooter
            ref={footerRef}
            className="grid gap-2 py-3"
            // A notice takes several lines: on a phone it rests at the end of the page, so it
            // does not stand over the text it is about.
            pinned={hasNotice ? "wide" : "always"}
          >
            {notice}
            {general.map((message) => (
              <FormNotice key={message} tone="error">
                {message}
              </FormNotice>
            ))}
            {canWrite ? (
              <SaveBar
                label={saveLabel}
                saving={saving}
                disabled={saveBlocked}
                dirty={dirty}
                whenClean="hidden"
                changes={
                  isNew
                    ? undefined
                    : t(control.changes === 1 ? "build.changeCount" : "build.changesCount", {
                        count: control.changes
                      })
                }
                discardLabel={isNew ? undefined : t("build.discard")}
                onDiscard={isNew ? undefined : control.discard}
                hint={t("configAppliesImmediately")}
              />
            ) : null}
          </PageFooter>
        ) : null}
      </form>
    </Page>
  );
}
