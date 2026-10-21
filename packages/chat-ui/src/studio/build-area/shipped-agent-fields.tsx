import type { ReactNode } from "react";
import { isShippedAgentSetField, type ShippedAgentField } from "@work-shape/catalyst-core";
import { Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { agentConfigToForm, type AgentFormState } from "./asset-form-model";

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
 * differently from what the platform ships says so under it and offers to reset it. For any
 * other agent, and for a field that is as shipped, the field shows alone.
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
  around(field: ShippedField, content: ReactNode): ReactNode;
} {
  const stored = input.config?.shipped;
  const shipped =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? agentConfigToForm({ ...input.config, ...stored })
      : undefined;
  return {
    shipped: shipped !== undefined,
    around: (field, content) =>
      shipped === undefined ||
      comparable(field, input.form[field]) === comparable(field, shipped[field]) ? (
        content
      ) : (
        <div className="grid gap-2" data-shipped-group={field}>
          {content}
          <ShippedFieldNote
            canReset={input.canEdit(field)}
            onReset={() => input.onReset({ [field]: shipped[field] })}
          />
        </div>
      )
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
