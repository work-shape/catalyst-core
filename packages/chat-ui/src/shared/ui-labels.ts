import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { uiLabelsDe, uiLabelsEn, type UiLabels } from "@work-shape/catalyst-ui";

/** The shared UI library's own texts in the interface language. */
export function uiLabelsFor(locale: LocaleCode): UiLabels {
  return locale === "de" ? uiLabelsDe : uiLabelsEn;
}
