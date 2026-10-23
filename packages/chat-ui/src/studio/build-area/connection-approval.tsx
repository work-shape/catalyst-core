import { useId, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Checkbox,
  FoldedText,
  List,
  Select,
  Textarea
} from "@work-shape/catalyst-ui";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import {
  APPROVAL_SURFACES,
  DEFAULT_APPROVAL_SURFACES,
  outsideReadingCut,
  readingNames,
  parameterEnums,
  withChosenEffects,
  type ApprovalCandidate,
  type ApprovalSurface
} from "./connection-approval-model";

// The list a person approves a Connection's tools in, with one confirmation: in the New
// connection dialog and on the Connection's page. One "may use" row opens every approved tool
// to agents, Apps or Workflows; each tool's exposure is changed on the page afterwards.

const SURFACE_LABELS: Record<ApprovalSurface, TranslationKey> = {
  agent: "connectionCreate.surfaceAgent",
  bridge: "connectionCreate.surfaceBridge",
  workflow: "connectionCreate.surfaceWorkflow"
};

type Effect = ApprovalCandidate["effect"];

/** A group of rows: its title, a line under it, and the names of its tools. */
export interface ApprovalGroup {
  id: string;
  title: ReactNode;
  note?: ReactNode;
  names: readonly string[];
}

/** What the person chose in the list: the tools, the surfaces and the effect of a tool. */
export interface ApprovalChoice {
  selected: ReadonlySet<string>;
  surfaces: ReadonlySet<ApprovalSurface>;
  /** The effect the person chose for a discovered tool, where it differs from its hint. */
  effects?: ReadonlyMap<string, Effect>;
}

/** The list's choice, starting with the tools that only read and with agents. */
export function useApprovalChoice(candidates: readonly ApprovalCandidate[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(readingNames(candidates))
  );
  const [surfaces, setSurfaces] = useState<ReadonlySet<ApprovalSurface>>(
    () => new Set(DEFAULT_APPROVAL_SURFACES)
  );
  const [effects, setEffects] = useState<ReadonlyMap<string, Effect>>(() => new Map());
  return {
    choice: { selected, surfaces, effects },
    setSelected,
    setSurfaces,
    setEffects,
    /** Starts again from the tools that only read, as for a new list. */
    reset(next: readonly ApprovalCandidate[]) {
      setSelected(new Set(readingNames(next)));
      setEffects(new Map());
    }
  };
}

/** "Approve N tools": the label of the one confirmation. */
export function approveLabel(count: number, t: TranslationContextValue["t"]): string {
  return count === 1 ? t("connectionCreate.approveOne") : t("connectionCreate.approve", { count });
}

export function ConnectionApprovalList({
  candidates,
  choice,
  onSelectedChange,
  onSurfacesChange,
  onEffectsChange,
  declared = false,
  source,
  groups,
  disabled = false
}: {
  candidates: readonly ApprovalCandidate[];
  choice: ApprovalChoice;
  onSelectedChange(selected: ReadonlySet<string>): void;
  onSurfacesChange(surfaces: ReadonlySet<ApprovalSurface>): void;
  /**
   * The person may accept a discovered tool as reading or changing, whatever its hint
   * proposed. Without it each row shows its effect only.
   */
  onEffectsChange?(effects: ReadonlyMap<string, Effect>): void;
  /** The tools are a REST API's declarations: each row shows its request, and they only read. */
  declared?: boolean;
  /** The YAML the declarations were pasted as, for "Show as YAML". */
  source?: string;
  /**
   * The rows in groups, each under its title with a line of its own, such as a catalogue
   * part's scope groups. Left out, one list.
   */
  groups?: readonly ApprovalGroup[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [yamlShown, setYamlShown] = useState(false);
  const surfacesLabel = useId();
  const { selected, surfaces } = choice;
  const effects = choice.effects ?? new Map<string, Effect>();
  const rows = withChosenEffects(candidates, effects);
  const toggle = <Item,>(set: ReadonlySet<Item>, item: Item, on: boolean): Set<Item> => {
    const next = new Set(set);
    if (on) next.add(item);
    else next.delete(item);
    return next;
  };
  const row = (candidate: ApprovalCandidate) => (
    <li
      key={candidate.name}
      data-approval-tool={candidate.name}
      className="flex min-w-0 items-start gap-3 border-b py-2.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <Checkbox
          checked={selected.has(candidate.name) && !outsideReadingCut(candidate)}
          disabled={disabled || outsideReadingCut(candidate)}
          label={candidate.title}
          description={
            candidate.request ? (
              <>
                <code className="block font-mono text-code break-all">
                  {candidate.request.method} {candidate.request.path}
                </code>
                {candidate.description ? (
                  // The agent that carries the tool reads it, and a draft's author may
                  // be an agent: whoever approves it sees it. A long one folds.
                  <FoldedText className="mt-0.5" data-approval-description="">
                    {candidate.description}
                  </FoldedText>
                ) : null}
                {parameterEnums(candidate.declaration).map((entry) => (
                  <span
                    key={`${entry.location}.${entry.name}.${entry.path}`}
                    className="mt-2 grid min-w-0 gap-0.5"
                    data-approval-parameter={`${entry.location}.${entry.name}`}
                  >
                    <span className="text-caption text-muted-foreground">
                      {t(
                        entry.location === "pathParams"
                          ? "connectionCreate.pathParameter"
                          : "connectionCreate.queryParameter",
                        { name: entry.name }
                      )}
                      {entry.path ? ` · ${entry.path}` : ""}
                    </span>
                    <span className="text-caption">{t("connectionCreate.allowedValues")}</span>
                    <FoldedText data-approval-enum={entry.path}>{entry.values}</FoldedText>
                  </span>
                ))}
              </>
            ) : candidate.description ? (
              // Whole: the model of an agent that carries the tool reads all of it, so
              // whoever approves it does too. A long one scrolls.
              <span className="block max-h-24 overflow-y-auto break-words whitespace-pre-line">
                {candidate.description}
              </span>
            ) : undefined
          }
          onCheckedChange={(on) => onSelectedChange(toggle(selected, candidate.name, on))}
        />
      </div>
      {onEffectsChange && candidate.request === undefined ? (
        <Select
          size="sm"
          className="w-28 shrink-0"
          value={candidate.effect}
          disabled={disabled}
          aria-label={t("connectionCreate.effectOf", { name: candidate.title })}
          data-approval-effect={candidate.name}
          onChange={(event) => {
            const next = new Map(effects);
            next.set(candidate.name, event.target.value === "reading" ? "reading" : "changing");
            onEffectsChange(next);
          }}
        >
          <option value="reading">{t("connectionCreate.reads")}</option>
          <option value="changing">{t("connectionCreate.changes")}</option>
        </Select>
      ) : (
        <Badge
          tone={
            candidate.effect === "changing" || outsideReadingCut(candidate) ? "warning" : "neutral"
          }
        >
          {t(
            candidate.effect === "changing" || outsideReadingCut(candidate)
              ? "connectionCreate.changes"
              : "connectionCreate.reads"
          )}
        </Badge>
      )}
    </li>
  );
  const changing = rows.some((candidate) => candidate.effect === "changing");
  const outsideCut = rows.filter(outsideReadingCut).length;
  return (
    <div className="grid min-w-0 gap-4" data-connection-approval="">
      <div
        role="group"
        aria-labelledby={surfacesLabel}
        className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2"
      >
        <span id={surfacesLabel} className="mr-1 text-label">
          {t("connectionCreate.mayUse")}
        </span>
        {APPROVAL_SURFACES.map((surface) => (
          <Checkbox
            key={surface}
            label={t(SURFACE_LABELS[surface])}
            checked={surfaces.has(surface)}
            disabled={disabled}
            data-approval-surface={surface}
            onCheckedChange={(on) => onSurfacesChange(toggle(surfaces, surface, on))}
          />
        ))}
      </div>
      <div className="grid min-w-0 overflow-hidden rounded-md border">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1 text-caption text-muted-foreground">
          <span data-approval-count="">
            {t("connectionCreate.selected", {
              selected: selected.size,
              count: candidates.length
            })}
          </span>
          {declared ? (
            source === undefined ? null : (
              <Button variant="link" size="sm" onClick={() => setYamlShown((shown) => !shown)}>
                {t(yamlShown ? "connectionCreate.hideYaml" : "connectionCreate.showYaml")}
              </Button>
            )
          ) : (
            <Button
              variant="link"
              size="sm"
              disabled={disabled}
              data-approval-only-reading=""
              onClick={() => onSelectedChange(new Set(readingNames(rows)))}
            >
              {t("connectionCreate.onlyReading")}
            </Button>
          )}
        </div>
        {yamlShown && source !== undefined ? (
          <div className="border-b p-3">
            <Textarea
              variant="code"
              readOnly
              rows={10}
              value={source}
              aria-label={t("connectionCreate.pasteField")}
            />
          </div>
        ) : null}
        {groups === undefined ? (
          <List aria-label={t("connectionCreate.toolsLabel")} className="px-3">
            {rows.map(row)}
          </List>
        ) : (
          groups.map((group) => (
            <div
              key={group.id}
              className="grid min-w-0 border-b last:border-b-0"
              data-approval-group={group.id}
            >
              <div className="grid min-w-0 gap-0.5 px-3 pt-2.5">
                <span className="text-label">{group.title}</span>
                {group.note}
              </div>
              <List
                aria-label={
                  typeof group.title === "string" ? group.title : t("connectionCreate.toolsLabel")
                }
                className="px-3"
              >
                {rows.filter((candidate) => group.names.includes(candidate.name)).map(row)}
              </List>
            </div>
          ))
        )}
      </div>
      {declared ? (
        <p className="text-caption text-muted-foreground" data-approval-reads-only="">
          {outsideCut === 0
            ? t("connectionCreate.readsOnly")
            : t(
                outsideCut === 1
                  ? "connectionCreate.outsideReadingCutOne"
                  : "connectionCreate.outsideReadingCut",
                { count: outsideCut }
              )}
        </p>
      ) : (
        <>
          {onEffectsChange ? (
            <p className="text-caption text-muted-foreground">{t("connectionCreate.effectHint")}</p>
          ) : null}
          {changing ? (
            <p className="text-caption text-muted-foreground">
              {t("connectionCreate.changingNote")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
