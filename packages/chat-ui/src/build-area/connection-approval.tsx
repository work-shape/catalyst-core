import { useId, useState } from "react";
import { Badge, Button, Checkbox, FoldedText, List, Textarea } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";
import {
  APPROVAL_SURFACES,
  DEFAULT_APPROVAL_SURFACES,
  readingNames,
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

/** What the person chose in the list: the tools and the surfaces. */
export interface ApprovalChoice {
  selected: ReadonlySet<string>;
  surfaces: ReadonlySet<ApprovalSurface>;
}

/** The list's choice, starting with the tools that only read and with agents. */
export function useApprovalChoice(candidates: readonly ApprovalCandidate[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(readingNames(candidates))
  );
  const [surfaces, setSurfaces] = useState<ReadonlySet<ApprovalSurface>>(
    () => new Set(DEFAULT_APPROVAL_SURFACES)
  );
  return {
    choice: { selected, surfaces },
    setSelected,
    setSurfaces,
    /** Starts again from the tools that only read, as for a new list. */
    reset(next: readonly ApprovalCandidate[]) {
      setSelected(new Set(readingNames(next)));
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
  declared = false,
  source,
  disabled = false
}: {
  candidates: readonly ApprovalCandidate[];
  choice: ApprovalChoice;
  onSelectedChange(selected: ReadonlySet<string>): void;
  onSurfacesChange(surfaces: ReadonlySet<ApprovalSurface>): void;
  /** The tools are a REST API's declarations: each row shows its request, and they only read. */
  declared?: boolean;
  /** The YAML the declarations were pasted as, for "Show as YAML". */
  source?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [yamlShown, setYamlShown] = useState(false);
  const surfacesLabel = useId();
  const { selected, surfaces } = choice;
  const toggle = <Item,>(set: ReadonlySet<Item>, item: Item, on: boolean): Set<Item> => {
    const next = new Set(set);
    if (on) next.add(item);
    else next.delete(item);
    return next;
  };
  const changing = candidates.some((candidate) => candidate.effect === "changing");
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
              onClick={() => onSelectedChange(new Set(readingNames(candidates)))}
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
        <List aria-label={t("connectionCreate.toolsLabel")} className="px-3">
          {candidates.map((candidate) => (
            <li
              key={candidate.name}
              data-approval-tool={candidate.name}
              className="flex min-w-0 items-start gap-3 border-b py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <Checkbox
                  checked={selected.has(candidate.name)}
                  disabled={disabled}
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
              <Badge tone={candidate.effect === "changing" ? "warning" : "neutral"}>
                {t(
                  candidate.effect === "changing"
                    ? "connectionCreate.changes"
                    : "connectionCreate.reads"
                )}
              </Badge>
            </li>
          ))}
        </List>
      </div>
      {declared ? (
        <p className="text-caption text-muted-foreground">{t("connectionCreate.readsOnly")}</p>
      ) : changing ? (
        <p className="text-caption text-muted-foreground">{t("connectionCreate.changingNote")}</p>
      ) : null}
    </div>
  );
}
