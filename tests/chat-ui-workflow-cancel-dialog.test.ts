import { createElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { CancelRunDialog } from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;
const noop = () => undefined;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

it("asks once before a run is cancelled, with a way to keep it running", () => {
  const dialog = (error?: string, locale: "en" | "de" = "en") =>
    render(
      createElement(CancelRunDialog, { loading: false, error, onConfirm: noop, onClose: noop }),
      locale
    );
  expect(dialog()).toContain(t("workflows.run.cancelTitle"));
  expect(dialog()).toContain(t("workflows.run.cancelBody"));
  expect(dialog()).toContain(t("workflows.run.cancelKeep"));
  expect(dialog(t("workflows.run.cancelFailed"))).toContain(t("workflows.run.cancelFailed"));
  expect(dialog(undefined, "de")).toContain(de("workflows.run.cancelKeep"));
});
