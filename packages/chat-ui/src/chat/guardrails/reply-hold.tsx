import { Banner, Spinner } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

// A reply held until its check ends, or withheld (GR-5; every client renders it from GR-4). The
// text held back never reaches the page: a held reply shows that it waits, a withheld one the
// guardrail and its reason.

export type ReplyHold =
  { state: "held" } | { state: "withheld"; guardrailId: string; reason: string };

/** The hold in a message part's data, where it is one. */
export function readReplyHold(data: unknown): ReplyHold | undefined {
  if (!data || typeof data !== "object" || !("state" in data)) return undefined;
  if (data.state === "held") return { state: "held" };
  if (
    data.state === "withheld" &&
    "guardrailId" in data &&
    typeof data.guardrailId === "string" &&
    "reason" in data &&
    typeof data.reason === "string"
  ) {
    return { state: "withheld", guardrailId: data.guardrailId, reason: data.reason };
  }
  return undefined;
}

export function ReplyHoldNotice({ hold }: { hold: ReplyHold }) {
  const { t } = useTranslation();
  if (hold.state === "held") {
    return (
      <div
        className="my-3 flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
        role="status"
        data-testid="reply-held"
      >
        <Spinner size="sm" />
        <span>{t("chatInput.hold.waiting")}</span>
      </div>
    );
  }
  return (
    <Banner
      className="my-3 max-w-3xl"
      tone="warning"
      title={t("chatInput.hold.withheld", { name: hold.guardrailId })}
      data-testid="reply-withheld"
    >
      <span className="block wrap-anywhere">
        {t("chatInput.hold.withheldReason", { reason: hold.reason })}
      </span>
    </Banner>
  );
}
