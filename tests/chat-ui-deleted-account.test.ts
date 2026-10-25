import { createElement } from "react";
import type { ConfigAssetRevision } from "@work-shape/catalyst-api-client";
import { RevisionsDrawerView } from "@work-shape/catalyst-chat-ui/apps";
import { describe, expect, it } from "vitest";
import { ApprovalDecisionLine } from "./support/chat-ui";
import { createTranslationContext } from "./support/chat-ui/shared";
import { startedByText } from "./support/chat-ui/studio-workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { renderItem } from "./chat-ui-inbox-harness";

// ERASE-ACTOR-IDS: where the server names a person whose account is gone, it sends an empty
// name. Every surface that shows who did something shows "Gelöschtes Konto" / "Deleted
// account" for it, never a blank and never the account's id.

const GONE = "usr_0b5c2e1e-7d1a-4c8e-9f3e-2a6d1c4b9e70";
const LABEL = { de: "Gelöschtes Konto", en: "Deleted account" } as const;
const LOCALES = ["de", "en"] as const;

const render = <P extends object>(
  node: (props: P) => ReturnType<typeof createElement>,
  props: P,
  locale: "de" | "en"
) =>
  renderToStaticMarkup(
    createElement(TranslationProvider, { locale, children: createElement(node, props) })
  );

describe("a person whose account is gone (ERASE-ACTOR-IDS)", () => {
  for (const locale of LOCALES) {
    // Fails without the change: "Angefragt von , …" and "Entscheidung von , …".
    it(`is named as a deleted account in the Inbox (${locale})`, () => {
      const markup = renderItem(
        {
          requestedBy: { id: GONE, displayLabel: "" },
          status: "reverted",
          decision: {
            approved: true,
            decidedBy: GONE,
            decidedByLabel: "",
            decidedAt: "2026-10-05T09:00:00Z"
          },
          reversion: { revertedBy: GONE, revertedByLabel: "", revertedAt: "2026-10-05T10:00:00Z" }
        },
        { locale }
      );
      const { t } = createTranslationContext(locale);
      for (const key of [
        "approvalRequestedBy",
        "approvalDecidedBy",
        "approvalRevertedBy"
      ] as const) {
        const [before] = t(key, { name: "\u0000", date: "" }).split("\u0000");
        expect(markup).toContain(`${before}${LABEL[locale]}`);
      }
      expect(markup).not.toContain(GONE);
    });

    // Fails without the change: "von  gestartet" / "started by ".
    it(`is named as a deleted account as who started a Workflow Run (${locale})`, () => {
      const { t } = createTranslationContext(locale);
      expect(startedByText({ startedBy: { id: GONE, name: "" } }, t)).toBe(
        t("workflows.run.startedByPerson", { person: LABEL[locale] })
      );
    });

    // Fails without the change: the revision showed its date and an empty name.
    it(`is named as a deleted account in an asset's history (${locale})`, () => {
      const revision = {
        assetId: "cfga_offer",
        revision: 1,
        operation: "create",
        config: { name: "offer", title: "Offer", manifest: {} },
        actor: { userId: GONE, displayLabel: "", roles: [] },
        globalVersion: 1,
        createdAt: "2026-10-01T09:30:00.000Z"
      } satisfies ConfigAssetRevision;
      const markup = render(
        RevisionsDrawerView,
        {
          open: true,
          name: "Offer",
          revisions: [revision],
          failed: false,
          hasMore: false,
          loadingMore: false,
          draftRevision: 1,
          publishedRevision: undefined,
          onLoadMore() {},
          onRetry() {},
          onClose() {}
        },
        locale
      );
      expect(markup).toContain(`${LABEL[locale]} · `);
      expect(markup).not.toContain(GONE);
    });

    // Fails without the change: "Übernommen von " / "Accepted by ".
    it(`is named as a deleted account in an approval decision in chat (${locale})`, () => {
      // As the chat reads it from an approval decision whose decider's account is gone.
      const decision: Parameters<typeof ApprovalDecisionLine>[0]["decision"] = {
        requestId: "apr_1",
        status: "approved",
        decidedByLabel: "",
        decidedAt: "2026-10-05T09:30:00.000Z",
        summary: "Auch die Steuerklasse prüfen."
      };
      const markup = render(ApprovalDecisionLine, { decision, showSummary: false }, locale);
      expect(markup).toContain(
        locale === "de" ? `Übernommen von ${LABEL.de}` : `Accepted by ${LABEL.en}`
      );
      expect(markup).not.toContain(GONE);
    });
  }
});
