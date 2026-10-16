import { useState, type ReactNode } from "react";
import type { ShippedGuardrailView } from "@work-shape/catalyst-api-client";
import { Badge, Chip, ConfirmDialog, InlineError, Switch } from "@work-shape/catalyst-ui";
import { formatMomentShort } from "../../shared/locale-format";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { BuildListLead, BuildListLeadFilter, BuildListLeadRow } from "./build-asset-kind";
import { GUARDRAIL_OUTCOME_VIEWS, readOutcome } from "./guardrail-model";
import type { ShippedGuardrailsRead } from "./guardrail-source";

/** The words of each guardrail the release ships, by its name. Another one shows the instance's. */
const SHIPPED_WORDS: Readonly<
  Record<
    string,
    { title: TranslationKey; text: TranslationKey; offText: TranslationKey; ask: TranslationKey }
  >
> = {
  "publishing-needs-approval": {
    title: "guardrails.shippedPublishTitle",
    text: "guardrails.shippedPublishText",
    offText: "guardrails.shippedPublishOffText",
    ask: "guardrails.shippedPublishOffAsk"
  }
};

/**
 * The guardrails the platform ships, as the first rows of the Guardrails list: each marked as
 * shipped with the platform, with what it does, its state and its switch for an instance admin.
 * They are instance guardrails: the list shows them in the instance's scope and where the search
 * matches their title. Switching one off asks first and says what changes; switching it on again
 * does not. Nobody else can switch it, and the line under it says who switched it last.
 */
export function ShippedGuardrailsLead({
  read,
  filter,
  children
}: {
  read: ShippedGuardrailsRead;
  filter: BuildListLeadFilter;
  children(lead: BuildListLead): ReactNode;
}) {
  const { locale, t } = useTranslation();
  const [refusal, setRefusal] = useState<string>();
  if (read.status === "loading") return children({ rows: undefined });
  if (read.status === "failed") {
    return children({
      rows: [],
      error: (
        <InlineError className="mb-4">{read.message ?? t("guardrails.shippedFailed")}</InlineError>
      )
    });
  }
  const text = filter.text.trim().toLocaleLowerCase(locale);
  const inScope =
    (filter.scope === undefined || filter.scope.kind === "instance") &&
    filter.namespace === undefined;
  const rows = read.items.flatMap((guardrail): BuildListLeadRow[] => {
    const words = SHIPPED_WORDS[guardrail.name];
    const title = words ? t(words.title) : guardrail.displayName;
    const matches = [title, guardrail.name].some((name) =>
      name.toLocaleLowerCase(locale).includes(text)
    );
    if (!inScope || !matches) return [];
    const outcome = GUARDRAIL_OUTCOME_VIEWS[readOutcome(guardrail.outcome)];
    const state = guardrail.switchedBy
      ? t(guardrail.enabled ? "guardrails.shippedOnBy" : "guardrails.shippedOffBy", {
          name: guardrail.switchedBy.label,
          when: guardrail.switchedAt ? formatMomentShort(guardrail.switchedAt, locale) : ""
        })
      : t("guardrails.shippedAsShipped");
    return [
      {
        key: `shipped:${guardrail.name}`,
        title,
        chips: (
          <>
            <Chip size="sm">{t("guardrails.shippedHeading")}</Chip>
            <Badge tone={outcome.tone} dot>
              {t(outcome.label)}
            </Badge>
          </>
        ),
        description: (
          <>
            <span className="block">
              {words ? t(guardrail.enabled ? words.text : words.offText) : guardrail.reason}
            </span>
            <span className="block" data-shipped-state="">
              {state}
              {guardrail.canSwitch ? "" : ` ${t("guardrails.shippedAdminOnly")}`}
            </span>
          </>
        ),
        actions: (
          <ShippedGuardrailSwitch
            guardrail={guardrail}
            title={title}
            ask={words ? t(words.ask) : guardrail.reason}
            read={read}
            onRefusal={setRefusal}
          />
        )
      }
    ];
  });
  return children({
    rows,
    ...(refusal ? { error: <InlineError className="mb-4">{refusal}</InlineError> } : {})
  });
}

/** The switch of one shipped guardrail, and the question before it is switched off. */
function ShippedGuardrailSwitch({
  guardrail,
  title,
  ask,
  read,
  onRefusal
}: {
  guardrail: ShippedGuardrailView;
  title: string;
  ask: string;
  read: Extract<ShippedGuardrailsRead, { status: "ready" }>;
  onRefusal(refusal: string | undefined): void;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const switching = read.switching === guardrail.name;
  const switchTo = async (enabled: boolean) => {
    onRefusal(undefined);
    const refused = await read.switchTo(guardrail.name, enabled);
    if (refused !== undefined) onRefusal(refused || t("guardrails.shippedSwitchFailed"));
    setAsking(false);
  };
  return (
    <>
      <Switch
        aria-label={t("guardrails.shippedSwitch", { name: title })}
        checked={guardrail.enabled}
        disabled={!guardrail.canSwitch || switching}
        onCheckedChange={(enabled) => {
          if (enabled) switchTo(true).catch(() => undefined);
          else setAsking(true);
        }}
      />
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t("guardrails.shippedOffTitle", { name: title })}
        confirmLabel={t("guardrails.shippedOffConfirm")}
        tone="danger"
        loading={switching}
        onConfirm={() => {
          switchTo(false).catch(() => undefined);
        }}
      >
        {ask}
      </ConfirmDialog>
    </>
  );
}
