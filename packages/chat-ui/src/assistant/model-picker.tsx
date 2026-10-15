import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn, LevelMeter, Popover, PopoverContent, PopoverTrigger } from "@work-shape/catalyst-ui";
import type { AgentSelectableModel, ReasoningEffort } from "../workspace/agent-model-selection";
import { modelDisplayLabel } from "../model-label";
import { useTranslation, type TranslationKey } from "../i18n";
import { EuResidencyBadge, ModelVendorIcon, modelVendorLabel } from "./model-vendor";

type UsageTier = NonNullable<AgentSelectableModel["usageTier"]>;

/** The usage tiers from least to most, as the meter on the model card counts them. */
const usageTiers: readonly UsageTier[] = [
  "very_low",
  "low",
  "moderate",
  "elevated",
  "high",
  "very_high"
];
const usageTierLabels: Record<UsageTier, TranslationKey> = {
  very_low: "modelUsageTierVeryLow",
  low: "modelUsageTierLow",
  moderate: "modelUsageTierModerate",
  elevated: "modelUsageTierElevated",
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

const VIEWPORT_GUTTER = 16;
/** Tailwind's `sm` breakpoint, from which panels open beside the menu. */
const BESIDE_MENU_QUERY = "(min-width: 40rem)";
/** What a `w-72` panel beside the menu takes with the gap between them. */
const PANEL_ROOM = 294;
/** How long the pointer rests on another row before its panel replaces the open one. */
const HOVER_SWITCH_MS = 250;

/** Whether the composer has anything to offer: another model, or an effort for the only one. */
export function hasModelChoice(
  models: AgentSelectableModel[],
  selectedModel: AgentSelectableModel | undefined
): boolean {
  return models.length > 1 || (selectedModel?.selectableReasoningEfforts.length ?? 0) > 1;
}

type Panel = "model" | "reasoning";

interface Placement {
  /** Panels open beside the menu; below the `sm` breakpoint one takes the menu's place. */
  beside: boolean;
  /** Panels open to the menu's right; otherwise to its left. */
  opensRight: boolean;
}

/**
 * Where panels open for a trigger: beside the menu from the breakpoint the stylesheet switches
 * on, to the right where the window has room for a panel there.
 */
function placementOf(trigger: HTMLElement | null): Placement {
  const right = trigger?.getBoundingClientRect().right ?? window.innerWidth;
  const beside = window.matchMedia(BESIDE_MENU_QUERY).matches;
  return {
    beside,
    opensRight: beside && window.innerWidth - VIEWPORT_GUTTER - right >= PANEL_ROOM
  };
}

const surfaceClassName = "rounded-xl border bg-popover text-popover-foreground shadow-lg";

/**
 * The composer's model control. It always opens as a short menu naming the model and its
 * reasoning effort; each row opens its own panel beside it, and a model under the pointer
 * brings up a card describing it. On a narrow screen a panel takes the menu's place instead.
 * Menu and panel open above the page, so a narrow column beside a canvas never cuts them off.
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
  const [panel, setPanel] = useState<Panel | undefined>();
  const [previewedModel, setPreviewedModel] = useState<AgentSelectableModel | undefined>();
  const [placement, setPlacement] = useState<Placement>({ beside: false, opensRight: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Where focus goes once the panel change under way has rendered: into the panel, or a row. */
  const pendingFocus = useRef<"panel" | Panel>(undefined);
  const selectedModel =
    models.find((model) => model.bindingId === selectedModelBindingId) ?? models[0];
  const { beside: besideMenu, opensRight } = placement;

  // A window that resizes while the picker is open can cross the breakpoint: the placement
  // follows it, or the room kept for a panel beside the menu would push a panel in its place
  // off the screen.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const measure = () => setPlacement(placementOf(triggerRef.current));
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    if (target === "panel") {
      focusIntoPanel(panelRef.current);
    } else if (target) {
      rowRefs.current[target]?.focus();
    }
  }, [panel]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  if (!selectedModel || !hasModelChoice(models, selectedModel)) {
    return null;
  }

  const efforts = selectedModel.selectableReasoningEfforts;
  const offersReasoning = efforts.length > 1 && reasoningEffort !== undefined;
  // Picking a model whose effort is fixed closes the reasoning panel with it.
  const shownPanel = panel === "reasoning" && !offersReasoning ? undefined : panel;

  // The menu opens above the trigger, flush with its right edge, and below it where the window
  // has no room above. Panels open to its right where the window has room for one, and to its
  // left otherwise. The menu keeps the room for a panel free on that side and shifts back inside
  // the window by what it would overhang. A panel hangs off the menu's edge rather than widening
  // it, so the menu never moves when a panel opens or changes: it would carry the other row
  // under the pointer. The model card sits on top of the menu, beside the list, for the same
  // reason.
  function changeOpen(nextOpen: boolean) {
    clearTimeout(hoverTimer.current);
    if (nextOpen) {
      setPlacement(placementOf(triggerRef.current));
      setPanel(undefined);
      setPreviewedModel(undefined);
    }
    setOpen(nextOpen);
  }

  // A panel opened from the keyboard takes the focus. So does one in the menu's place, where
  // the row that opened it is gone.
  function showPanel(next: Panel, takeFocus: boolean) {
    clearTimeout(hoverTimer.current);
    const focus = takeFocus || !besideMenu;
    if (next === shownPanel) {
      if (focus) {
        focusIntoPanel(panelRef.current);
      }
      return;
    }
    pendingFocus.current = focus ? "panel" : undefined;
    setPanel(next);
    setPreviewedModel(undefined);
  }

  /** One level back: the panel closes and its row has the focus. */
  function closePanel() {
    clearTimeout(hoverTimer.current);
    pendingFocus.current = shownPanel;
    setPanel(undefined);
    setPreviewedModel(undefined);
  }

  // The arrow key towards the panel enters it and the other one comes back. The effort slider
  // keeps the arrow keys for itself; Escape leaves it.
  const intoKey = besideMenu && !opensRight ? "ArrowLeft" : "ArrowRight";
  const backKey = intoKey === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === backKey && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      closePanel();
    }
  }

  const menuRow = (rowPanel: Panel, label: string, value: ReactNode) => (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
        shownPanel === rowPanel && "bg-accent text-accent-foreground"
      )}
      ref={(node) => {
        rowRefs.current[rowPanel] = node;
      }}
      aria-expanded={shownPanel === rowPanel}
      aria-haspopup="dialog"
      onPointerEnter={(event) => {
        // Only where the panel opens beside the menu: in its place it would slide under the
        // pointer and take the click meant for this row.
        if (event.pointerType !== "mouse" || !besideMenu || shownPanel === rowPanel) {
          return;
        }
        clearTimeout(hoverTimer.current);
        if (shownPanel === undefined) {
          showPanel(rowPanel, false);
          return;
        }
        // With a panel open the pointer may only be crossing this row on its way into it, so
        // this row's panel replaces it once the pointer rests here.
        hoverTimer.current = setTimeout(() => showPanel(rowPanel, false), HOVER_SWITCH_MS);
      }}
      onPointerLeave={() => clearTimeout(hoverTimer.current)}
      onKeyDown={(event) => {
        if (event.key === intoKey) {
          event.preventDefault();
          showPanel(rowPanel, true);
        }
      }}
      // A click from the keyboard (Enter or Space) carries no pointer presses.
      onClick={(event) => showPanel(rowPanel, event.detail === 0)}
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

  // Beside the menu a panel hangs off its edge, level with its foot where the menu opens
  // upwards and with its head where it opens downwards, no taller than the window allows.
  const panelClassName = cn(
    "flex max-h-(--radix-popover-content-available-height) w-72 max-w-full flex-col overflow-hidden",
    "sm:absolute sm:max-w-none",
    "group-data-[side=top]/picker:bottom-0 group-data-[side=bottom]/picker:top-0",
    opensRight ? "sm:left-full sm:ml-1.5" : "sm:right-full sm:mr-1.5"
  );

  const backRow = (
    <button
      type="button"
      className="flex h-9 w-full shrink-0 items-center gap-1.5 border-b px-3 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground sm:hidden"
      onClick={closePanel}
    >
      <ChevronLeft size={14} aria-hidden="true" />
      {t(shownPanel === "model" ? "modelPickerModel" : "modelPickerReasoning")}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            "inline-flex h-9 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors",
            "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
            "disabled:pointer-events-none disabled:opacity-50",
            open && "bg-accent text-accent-foreground"
          )}
          aria-label={t("selectModel")}
          disabled={disabled}
        >
          <ModelVendorIcon model={selectedModel} size={14} className="shrink-0" />
          <span className="truncate">{modelDisplayLabel(selectedModel)}</span>
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
      </PopoverTrigger>

      <PopoverContent
        surface="none"
        size="fit"
        side="top"
        align="end"
        sideOffset={8}
        reserve={
          besideMenu ? (opensRight ? { right: PANEL_ROOM } : { left: PANEL_ROOM }) : undefined
        }
        onEscapeKeyDown={(event) => {
          if (shownPanel) {
            event.preventDefault();
            closePanel();
          }
        }}
        aria-label={t("selectModel")}
        className="group/picker relative max-w-[calc(100vw-2rem)]"
      >
        {shownPanel === "model" ? (
          <div
            ref={panelRef}
            className={cn(surfaceClassName, panelClassName)}
            onPointerEnter={() => clearTimeout(hoverTimer.current)}
            onKeyDown={onPanelKeyDown}
          >
            {backRow}
            <div
              role="listbox"
              aria-label={t("selectModel")}
              className="grid max-h-72 min-h-0 gap-0.5 overflow-y-auto p-1.5"
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
                      closePanel();
                    }}
                  >
                    <ModelVendorIcon model={model} />
                    <span className="truncate font-medium">{modelDisplayLabel(model)}</span>
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
          <div
            ref={panelRef}
            className={cn(surfaceClassName, panelClassName)}
            onPointerEnter={() => clearTimeout(hoverTimer.current)}
            onKeyDown={onPanelKeyDown}
          >
            {backRow}
            <ReasoningEffortSlider
              className="min-h-0 overflow-y-auto"
              efforts={efforts}
              value={reasoningEffort}
              onChange={(effort) => onSelectReasoningEffort(selectedModel.bindingId ?? "", effort)}
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
                "group-data-[side=top]/picker:bottom-full group-data-[side=top]/picker:mb-1.5",
                "group-data-[side=bottom]/picker:top-full group-data-[side=bottom]/picker:mt-1.5"
              )}
            />
          ) : null}
          {menuRow(
            "model",
            t("modelPickerModel"),
            <>
              <ModelVendorIcon model={selectedModel} size={14} className="shrink-0" />
              <span className="truncate">{modelDisplayLabel(selectedModel)}</span>
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
      </PopoverContent>
    </Popover>
  );
}

/** Focuses the selected option of a panel, or its first option or control. */
function focusIntoPanel(panel: HTMLElement | null) {
  const target =
    panel?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
    panel?.querySelector<HTMLElement>('[role="option"], input');
  target?.focus();
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

/** What the picker shows for the model under the pointer: its maker, description, usage and region. */
export function ModelCard({
  model,
  className
}: {
  model: AgentSelectableModel;
  className?: string;
}) {
  const { t } = useTranslation();
  const vendorLabel = modelVendorLabel(model);

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
          <span className="font-semibold">{modelDisplayLabel(model)}</span>
        </span>
      </div>
      {model.description ? (
        <p className="text-xs leading-5 text-muted-foreground">{model.description}</p>
      ) : null}
      {model.usageTier ? (
        <LevelMeter
          label={t("modelPickerUsage")}
          level={usageTiers.indexOf(model.usageTier) + 1}
          steps={usageTiers.length}
          valueLabel={t(usageTierLabels[model.usageTier])}
          scale="spectrum"
        />
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
