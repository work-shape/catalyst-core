import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { OperationPaging } from "@work-shape/catalyst-core";
import type { TranslationContextValue } from "../../shared/i18n";

/**
 * How an accepted operation pages, as one sentence: the form, the parameters it sends and,
 * for page and offset, the page size and where it starts when that is set.
 */
export function operationPagingText(
  paging: OperationPaging,
  t: TranslationContextValue["t"],
  locale: LocaleCode
): string {
  if ("cursor" in paging) {
    return t(paging.by === "cursor" ? "connections.pagingCursor" : "connections.pagingNextLink", {
      param: paging.param,
      cursor: paging.cursor
    });
  }
  const number = new Intl.NumberFormat(locale);
  const text = t(paging.by === "page" ? "connections.pagingPage" : "connections.pagingOffset", {
    param: paging.param,
    sizeParam: paging.sizeParam,
    size: number.format(paging.size)
  });
  return paging.start === undefined
    ? text
    : t("connections.pagingStart", { text, start: number.format(paging.start) });
}
