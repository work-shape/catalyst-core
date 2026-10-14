import { useState } from "react";
import type { ShippedGuardrailView } from "@vivd-catalyst/api-client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  InlineError,
  SkeletonList,
  Switch
} from "@vivd-catalyst/ui";
import { formatMomentShort } from "../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../i18n";
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
 * The guardrails the platform ships, above the Guardrails list: what each does, and its switch
 * for an instance admin. Switching one off asks first and says what changes; switching it on
 * again does not. Nobody else can switch it, and the line under it says who switched it last.
 */
export function ShippedGuardrails({ read }: { read: ShippedGuardrailsRead }) {
  const { t } = useTranslation();
  if (read.status === "loading") return <SkeletonList rows={1} />;
  if (read.status === "failed") {
    return <InlineError>{read.message ?? t("guardrails.shippedFailed")}</InlineError>;
  }
  return (
    <section aria-label={t("guardrails.shippedHeading")} className="grid gap-3">
      {read.items.map((guardrail) => (
        <ShippedGuardrailCard key={guardrail.name} guardrail={guardrail} read={read} />
      ))}
    </section>
  );
}

function ShippedGuardrailCard({
  guardrail,
  read
}: {
  guardrail: ShippedGuardrailView;
  read: Extract<ShippedGuardrailsRead, { status: "ready" }>;
}) {
  const { locale, t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const words = SHIPPED_WORDS[guardrail.name];
  const title = words ? t(words.title) : guardrail.displayName;
  const outcome = GUARDRAIL_OUTCOME_VIEWS[readOutcome(guardrail.outcome)];
  const switching = read.switching === guardrail.name;
  const switchTo = async (enabled: boolean) => {
    setRefusal(undefined);
    const refused = await read.switchTo(guardrail.name, enabled);
    if (refused !== undefined) setRefusal(refused || t("guardrails.shippedSwitchFailed"));
    setAsking(false);
  };
  const state = guardrail.switchedBy
    ? t(guardrail.enabled ? "guardrails.shippedOnBy" : "guardrails.shippedOffBy", {
        name: guardrail.switchedBy.label,
        when: guardrail.switchedAt ? formatMomentShort(guardrail.switchedAt, locale) : ""
      })
    : t("guardrails.shippedAsShipped");

  return (
    <Card padding="md">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{title}</CardTitle>
              <Badge tone={outcome.tone} dot>
                {t(outcome.label)}
              </Badge>
            </div>
            <p className="text-body text-muted-foreground">
              {words ? t(guardrail.enabled ? words.text : words.offText) : guardrail.reason}
            </p>
          </div>
          <Switch
            aria-label={t("guardrails.shippedSwitch", { name: title })}
            checked={guardrail.enabled}
            disabled={!guardrail.canSwitch || switching}
            onCheckedChange={(enabled) => {
              if (enabled) void switchTo(true);
              else setAsking(true);
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-caption text-muted-foreground">
          {state}
          {guardrail.canSwitch ? "" : ` ${t("guardrails.shippedAdminOnly")}`}
        </p>
        {refusal ? <InlineError>{refusal}</InlineError> : null}
      </CardContent>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t("guardrails.shippedOffTitle", { name: title })}
        confirmLabel={t("guardrails.shippedOffConfirm")}
        tone="danger"
        loading={switching}
        onConfirm={() => void switchTo(false)}
      >
        {words ? t(words.ask) : guardrail.reason}
      </ConfirmDialog>
    </Card>
  );
}
