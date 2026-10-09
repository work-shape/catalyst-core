import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@vivd-catalyst/ui";
import type { AgentSelectableModel, ReasoningEffort } from "../workspace/agent-model-selection";
import { formatModelLabel } from "../model-label";
import { useTranslation, type TranslationKey } from "../i18n";
import { EuResidencyBadge, ModelVendorIcon, modelVendorLabel } from "./model-vendor";

type UsageTier = NonNullable<AgentSelectableModel["usageTier"]>;

const usageTiers: UsageTier[] = ["low", "moderate", "high", "very_high"];
const usageTierLabels: Record<UsageTier, TranslationKey> = {
  low: "modelUsageTierLow",
  moderate: "modelUsageTierModerate",
  high: "modelUsageTierHigh",
  very_high: "modelUsageTierVeryHigh"
};
const reasoningEffortLabels: Record<ReasoningEffort, TranslationKey> = {
  none: "reasoningEffortNone",
  low: "reasoningEffortLow",
  medium: "reasoningEffortMedium",
  high: "reasoningEffortHigh",
  xhigh: "reasoningEffortXhigh",
  max: "reasoningEffortMax"
};

/** Room the popover needs above the composer before it opens downwards instead. */
const POPOVER_HEIGHT = 340;
const VIEWPORT_GUTTER = 16;
/** Tailwind's `sm` breakpoint, from which panels open beside the menu. */
const BESIDE_MENU_QUERY = "(min-width: 40rem)";
/** The menu's `w-64`, and what a `w-72` panel beside it takes with the gap between them. */
const MENU_WIDTH = "16rem";
const PANEL_ROOM = 294;

/** Whether the composer has anything to offer: another model, or an effort for the only one. */
export function hasModelChoice(
  models: AgentSelectableModel[],
  selectedModel: AgentSelectableModel | undefined
): boolean {
  return models.length > 1 || (selectedModel?.selectableReasoningEfforts.length ?? 0) > 1;
}

type Panel = "model" | "reasoning";

const surfaceClassName = "rounded-xl border bg-popover text-popover-foreground shadow-lg";

/**
 * The composer's model control. It always opens as a short menu naming the model and its
 * reasoning effort; each row opens its own panel beside it, and a model under the pointer
 * brings up a card describing it. On a narrow screen a panel takes the menu's place instead.
 */
export function ModelPicker({
  models,
  selectedModelBindingId,
  reasoningEffort,
  disabled,
  onSelectModelBinding,
  onSelectReasoningEffort
}: {
  /** The active agent's own model first, then the models users may pick instead. */
  models: AgentSelectableModel[];
  selectedModelBindingId: string | undefined;
  /** The effort a run with the selected model would use. */
  reasoningEffort: ReasoningEffort | undefined;
  disabled?: boolean;
  onSelectModelBinding: (modelBindingId: string) => void;
  onSelectReasoningEffort: (modelBindingId: string, effort: ReasoningEffort) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [opensDown, setOpensDown] = useState(false);
  const [panel, setPanel] = useState<Panel | undefined>();
  const [previewedModel, setPreviewedModel] = useState<AgentSelectableModel | undefined>();
  const [opensRight, setOpensRight] = useState(false);
  const [nudge, setNudge] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const selectedModel =
    models.find((model) => model.bindingId === selectedModelBindingId) ?? models[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The menu sits above the trigger, flush with its right edge. Panels open to its right where
  // the window has room for one, and to its left otherwise. Whatever would still pass a window
  // edge moves the popover back by what it overhangs. The model card sits on top of the menu,
  // beside the list, so it needs no room of its own and never moves the list under the pointer.
  useLayoutEffect(() => {
    if (open && popoverRef.current) {
      const rect = popoverRef.current.getBoundingClientRect();
      const overhangsLeft = VIEWPORT_GUTTER - (rect.left - nudge);
      const overhangsRight = rect.right - nudge - (window.innerWidth - VIEWPORT_GUTTER);
      setNudge(overhangsRight > 0 ? -overhangsRight : Math.max(0, overhangsLeft));
    }
  }, [open, panel, opensRight]);

  if (!selectedModel || !hasModelChoice(models, selectedModel)) {
    return null;
  }

  const efforts = selectedModel.selectableReasoningEfforts;
  const offersReasoning = efforts.length > 1 && reasoningEffort !== undefined;
  // Picking a model whose effort is fixed closes the reasoning panel with it.
  const shownPanel = panel === "reasoning" && !offersReasoning ? undefined : panel;

  function toggle() {
    const trigger = rootRef.current?.getBoundingClientRect();
    setOpensDown((trigger?.top ?? POPOVER_HEIGHT) < POPOVER_HEIGHT);
    setOpensRight(
      window.matchMedia(BESIDE_MENU_QUERY).matches &&
        window.innerWidth - VIEWPORT_GUTTER - (trigger?.right ?? window.innerWidth) >= PANEL_ROOM
    );
    setPanel(undefined);
    setPreviewedModel(undefined);
    setNudge(0);
    setOpen((currentOpen) => !currentOpen);
  }

  function showPanel(next: Panel) {
    setPanel(next);
    setPreviewedModel(undefined);
  }

  const menuRow = (rowPanel: Panel, label: string, value: ReactNode) => (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
        shownPanel === rowPanel && "bg-accent text-accent-foreground"
      )}
      aria-expanded={shownPanel === rowPanel}
      aria-haspopup="dialog"
      onPointerEnter={(event) => {
        // Only where the panel opens beside the menu: in its place it would slide under the
        // pointer and take the click meant for this row.
        if (event.pointerType === "mouse" && window.matchMedia(BESIDE_MENU_QUERY).matches) {
          showPanel(rowPanel);
        }
      }}
      onClick={() => showPanel(rowPanel)}
    >
      {/* The chevron points to where the panel opens: beside the menu, or in its place on a
          narrow screen. */}
      {opensRight ? null : (
        <ChevronLeft size={14} className="shrink-0 opacity-60 max-sm:hidden" aria-hidden="true" />
      )}
      <span className="font-medium">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {value}
      </span>
      <ChevronRight
        size={14}
        className={cn("shrink-0 opacity-60", !opensRight && "sm:hidden")}
        aria-hidden="true"
      />
    </button>
  );

  const backRow = (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-1.5 border-b px-3 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground sm:hidden"
      onClick={() => setPanel(undefined)}
    >
      <ChevronLeft size={14} aria-hidden="true" />
      {t(shownPanel === "model" ? "modelPickerModel" : "modelPickerReasoning")}
    </button>
  );

  return (
    <div ref={rootRef} className="relative min-w-0 shrink">
      <button
        type="button"
        className={cn(
          "inline-flex h-9 max-w-56 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors",
          "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
          "disabled:pointer-events-none disabled:opacity-50",
          open && "bg-accent text-accent-foreground"
        )}
        aria-label={t("selectModel")}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={toggle}
      >
        <ModelVendorIcon model={selectedModel} size={14} className="shrink-0" />
        <span className="truncate">{formatModelLabel(selectedModel.model)}</span>
        {offersReasoning ? (
          <span className="hidden shrink-0 font-normal opacity-75 sm:inline">
            {t(reasoningEffortLabels[reasoningEffort])}
          </span>
        ) : null}
        <ChevronDown
          size={13}
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("selectModel")}
          style={
            opensRight ? { left: `calc(100% - ${MENU_WIDTH} + ${nudge}px)` } : { right: -nudge }
          }
          className={cn(
            "absolute z-50 flex max-w-[calc(100vw-2rem)] gap-1.5",
            // Panel and menu are written left to right; opening rightwards reverses them.
            opensRight && "flex-row-reverse",
            opensDown ? "top-full mt-2 items-start" : "bottom-full mb-2 items-end"
          )}
        >
          {shownPanel === "model" ? (
            <div className={cn(surfaceClassName, "w-72 max-w-full overflow-hidden")}>
              {backRow}
              <div
                role="listbox"
                aria-label={t("selectModel")}
                className="grid max-h-72 gap-0.5 overflow-y-auto p-1.5"
                onPointerLeave={() => setPreviewedModel(undefined)}
              >
                {models.map((model) => {
                  const selected = model === selectedModel;
                  return (
                    <button
                      key={model.bindingId ?? ""}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cn(
                        "grid min-h-9 grid-cols-[1rem_minmax(0,1fr)_auto_1rem] items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
                        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                        selected && "bg-accent text-accent-foreground"
                      )}
                      onPointerEnter={(event) => {
                        if (event.pointerType === "mouse") {
                          setPreviewedModel(model);
                        }
                      }}
                      onFocus={() => setPreviewedModel(model)}
                      onBlur={() => setPreviewedModel(undefined)}
                      onClick={() => {
                        onSelectModelBinding(model.bindingId ?? "");
                        setPanel(undefined);
                        setPreviewedModel(undefined);
                      }}
                    >
                      <ModelVendorIcon model={model} />
                      <span className="truncate font-medium">{formatModelLabel(model.model)}</span>
                      {model.region === "eu" ? (
                        <EuResidencyBadge size={14} label={t("modelPickerResidencyEu")} />
                      ) : (
                        <span />
                      )}
                      <Check
                        size={15}
                        className={cn("text-primary", !selected && "opacity-0")}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {shownPanel === "reasoning" && offersReasoning ? (
            <div className={cn(surfaceClassName, "w-72 max-w-full overflow-hidden")}>
              {backRow}
              <ReasoningEffortSlider
                efforts={efforts}
                value={reasoningEffort}
                onChange={(effort) =>
                  onSelectReasoningEffort(selectedModel.bindingId ?? "", effort)
                }
              />
            </div>
          ) : null}

          <div
            className={cn(
              surfaceClassName,
              "relative grid w-64 shrink-0 gap-0.5 p-1.5",
              shownPanel && "max-sm:hidden"
            )}
          >
            {shownPanel === "model" && previewedModel ? (
              <ModelCard
                model={previewedModel}
                className={cn(
                  "absolute -inset-x-px",
                  opensDown ? "top-full mt-1.5" : "bottom-full mb-1.5"
                )}
              />
            ) : null}
            {menuRow(
              "model",
              t("modelPickerModel"),
              <>
                <ModelVendorIcon model={selectedModel} size={14} className="shrink-0" />
                <span className="truncate">{formatModelLabel(selectedModel.model)}</span>
              </>
            )}
            {offersReasoning ? (
              menuRow(
                "reasoning",
                t("modelPickerReasoning"),
                t(reasoningEffortLabels[reasoningEffort])
              )
            ) : reasoningEffort ? (
              // A model with a fixed effort still says which one it runs with.
              <div className="flex h-9 items-center gap-2 px-2 text-sm text-muted-foreground">
                {opensRight ? null : <span className="w-3.5 shrink-0 max-sm:hidden" />}
                <span className="font-medium">{t("modelPickerReasoning")}</span>
                <span className="ml-auto">{t(reasoningEffortLabels[reasoningEffort])}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReasoningEffortSlider({
  className,
  efforts,
  value,
  onChange
}: {
  className?: string;
  efforts: ReasoningEffort[];
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
}) {
  const { t } = useTranslation();
  const index = Math.max(0, efforts.indexOf(value));
  const last = efforts.length - 1;
  // The thumb's centre travels between half a thumb from either end of the track.
  const stop = (position: number) => `calc(0.75rem + (100% - 1.5rem) * ${position / last})`;

  return (
    <div className={cn("grid gap-2.5 px-3.5 pb-3.5 pt-3", className)}>
      <p className="text-center text-sm font-semibold">{t(reasoningEffortLabels[value])}</p>
      <div className="relative h-6 rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `calc(1.5rem + (100% - 1.5rem) * ${index / last})` }}
        />
        {efforts.map((effort, position) => (
          <span
            key={effort}
            className={cn(
              "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
              position < index ? "bg-primary-foreground/70" : "bg-muted-foreground/50"
            )}
            style={{ left: stop(position) }}
          />
        ))}
        <input
          type="range"
          className="model-picker-range absolute inset-0 size-full"
          min={0}
          max={last}
          step={1}
          value={index}
          aria-label={t("modelPickerReasoning")}
          aria-valuetext={t(reasoningEffortLabels[value])}
          onChange={(event) => onChange(efforts[Number(event.target.value)] ?? value)}
        />
      </div>
      <p className="text-center text-xs leading-4 text-muted-foreground">
        {t("modelPickerReasoningHint")}
      </p>
    </div>
  );
}

function ModelCard({ model, className }: { model: AgentSelectableModel; className?: string }) {
  const { t } = useTranslation();
  const vendorLabel = modelVendorLabel(model);
  const level = model.usageTier ? usageTiers.indexOf(model.usageTier) : -1;

  return (
    <div
      className={cn(
        surfaceClassName,
        "pointer-events-none hidden content-start gap-3 p-3.5 sm:grid",
        className
      )}
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <ModelVendorIcon model={model} className="shrink-0" />
        <span className="min-w-0 truncate">
          {vendorLabel ? <span className="text-muted-foreground">{vendorLabel} / </span> : null}
          <span className="font-semibold">{formatModelLabel(model.model)}</span>
        </span>
      </div>
      {model.description ? (
        <p className="text-xs leading-5 text-muted-foreground">{model.description}</p>
      ) : null}
      {model.usageTier ? (
        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t("modelPickerUsage")}</span>
            <span className="font-medium">{t(usageTierLabels[model.usageTier])}</span>
          </div>
          <div className="grid grid-cols-4 gap-0.5">
            {usageTiers.map((step, index) => (
              <span
                key={step}
                className={cn(
                  "h-1 rounded-full",
                  index <= level ? "bg-muted-foreground" : "bg-muted-foreground/25"
                )}
              />
            ))}
          </div>
        </div>
      ) : null}
      {model.region === "eu" || model.region === "global" ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {model.region === "eu" ? (
            <>
              <EuResidencyBadge size={14} label={t("modelPickerResidencyEu")} />
              {t("modelPickerResidencyEu")}
            </>
          ) : (
            t("modelPickerResidencyGlobal")
          )}
        </div>
      ) : null}
    </div>
  );
}
