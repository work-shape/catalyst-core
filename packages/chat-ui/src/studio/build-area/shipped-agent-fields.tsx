import type { ReactNode } from "react";
import { isShippedAgentSetField, type ShippedAgentField } from "@work-shape/catalyst-core";
import { Banner, Button, FoldedText } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { agentConfigToForm, type AgentFormState, type LocalizedPair } from "./asset-form-model";

type ShippedField = ShippedAgentField & keyof AgentFormState;

function comparable(field: ShippedField, value: AgentFormState[ShippedField]): string {
  return JSON.stringify(
    // Names compare as sets: the order of a list of tools or skills says nothing.
    isShippedAgentSetField(field) && Array.isArray(value)
      ? value.map((entry) => JSON.stringify(entry)).sort()
      : value
  );
}

/**
 * An agent that ships with the platform, such as Workshaper: each field the form holds
 * differently from what the platform ships says so under it and offers to reset it. Where a
 * release shipped a new version of a field the instance changed, the field offers the new
 * version beside the instance's, to take or to keep. For any other agent, and for a field that
 * is as shipped, the field shows alone.
 */
export function shippedFieldsView(input: {
  /** The agent's stored definition, which names what the platform shipped as `shipped`. */
  config: Record<string, unknown> | undefined;
  form: AgentFormState;
  canEdit(field: ShippedField): boolean;
  onReset(patch: Partial<AgentFormState>): void;
}): {
  /** Whether the agent ships with the platform. */
  shipped: boolean;
  /** Whether the field holds what the platform ships. */
  asShipped(field: ShippedField): boolean;
  around(field: ShippedField, content: ReactNode): ReactNode;
} {
  const stored = input.config?.shipped;
  const shipped =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? agentConfigToForm({ ...input.config, ...stored })
      : undefined;
  const asShipped = (field: ShippedField) =>
    shipped === undefined ||
    comparable(field, input.form[field]) === comparable(field, shipped[field]);
  return {
    shipped: shipped !== undefined,
    asShipped,
    around: (field, content) => {
      if (shipped === undefined || asShipped(field)) return content;
      const without = (input.form.shippedNewer ?? []).filter((each) => each !== field);
      return (
        <div className="grid gap-2" data-shipped-group={field}>
          {content}
          {input.form.shippedNewer?.includes(field) ? (
            <ShippedNewerNotice
              field={field}
              mine={input.form}
              next={shipped}
              canDecide={input.canEdit(field)}
              onTake={() => input.onReset({ [field]: shipped[field], shippedNewer: without })}
              onKeep={() => input.onReset({ shippedNewer: without })}
            />
          ) : (
            <ShippedFieldNote
              canReset={input.canEdit(field)}
              onReset={() => input.onReset({ [field]: shipped[field] })}
            />
          )}
        </div>
      );
    }
  };
}

function ShippedFieldNote({ canReset, onReset }: { canReset: boolean; onReset(): void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2" data-shipped-differs="">
      <span className="text-caption text-muted-foreground">{t("agentDraft.shippedDiffers")}</span>
      {canReset ? (
        <Button variant="link" size="sm" onClick={onReset}>
          {t("agentDraft.shippedReset")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A release shipped a new version of a field the instance changed: both side by side, and the
 * person takes the new one or keeps their own. Either is a change of the form, saved as any.
 */
function ShippedNewerNotice({
  field,
  mine,
  next,
  canDecide,
  onTake,
  onKeep
}: {
  field: ShippedField;
  mine: AgentFormState;
  next: AgentFormState;
  canDecide: boolean;
  onTake(): void;
  onKeep(): void;
}) {
  const { locale, t } = useTranslation();
  const text = (form: AgentFormState) => fieldText(field, form, locale);
  return (
    <Banner tone="info" data-shipped-newer={field}>
      <div className="grid min-w-0 gap-3">
        <p>{t("agentDraft.shippedNewer")}</p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="grid min-w-0 content-start gap-1">
            <span className="text-caption font-medium">{t("agentDraft.shippedNewerMine")}</span>
            <FoldedText>{text(mine) || t("agentDraft.empty")}</FoldedText>
          </div>
          <div className="grid min-w-0 content-start gap-1">
            <span className="text-caption font-medium">{t("agentDraft.shippedNewerNext")}</span>
            <FoldedText>{text(next) || t("agentDraft.empty")}</FoldedText>
          </div>
        </div>
        {canDecide ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onTake}>
              {t("agentDraft.shippedTakeNewer")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onKeep}>
              {t("agentDraft.shippedKeepMine")}
            </Button>
          </div>
        ) : null}
      </div>
    </Banner>
  );
}

/** A field of text as a person reads it: in their language, a starter by its title. */
function fieldText(field: ShippedField, form: AgentFormState, locale: string): string {
  const pair = (value: LocalizedPair) =>
    (locale === "de" ? value.de || value.en : value.en || value.de).trim();
  switch (field) {
    case "instructions":
      return form.instructions;
    case "displayName":
    case "description":
    case "welcomeMessage":
      return pair(form[field]);
    case "initialPrompts":
      return form.initialPrompts
        .map((prompt) => pair(prompt.title) || pair(prompt.prompt))
        .join("\n");
    default:
      return "";
  }
}
