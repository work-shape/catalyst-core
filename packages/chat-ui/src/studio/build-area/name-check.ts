import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { ASSET_ADDRESS_MAX_LENGTH } from "@work-shape/catalyst-core";
import type { AddressCheck } from "@work-shape/catalyst-ui";
import type { CheckName, NameCheckAnswer } from "../../shared/api/asset-writes";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";
import { BUILD_SEARCH_DELAY_MS } from "./build-data";
import { readBuildRefusal } from "./build-refusals";

type Translate = TranslationContextValue["t"];

/**
 * The instance's answer as the field shows it. A refused check, such as of a workspace the
 * reader may not write in, shows the refusal; a check that failed blocks nothing, and the
 * create meets the instance's answer.
 */
export function addressCheckOf(
  answer: { ok: true; found: NameCheckAnswer } | { ok: false; error: unknown },
  t: Translate,
  locale: LocaleCode
): AddressCheck {
  if (answer.ok) {
    const { found } = answer;
    return found.available
      ? { state: "free" }
      : {
          state: "refused",
          reason:
            found.reason === "name_taken"
              ? t("build.addressTaken")
              : t("build.addressInvalid", { max: ASSET_ADDRESS_MAX_LENGTH })
        };
  }
  // Only the instance's refusal carries a code; a lost connection says nothing of the name.
  const outcome =
    apiErrorCode(answer.error) === undefined
      ? undefined
      : readBuildRefusal(answer.error, t, locale);
  return outcome && !outcome.ok && !outcome.conflict
    ? { state: "refused", reason: outcome.refusals.map((refusal) => refusal.message).join(" ") }
    : { state: "unchecked" };
}

/**
 * A refused address stops the create. One still being checked does not, so the button does
 * not flicker while the person types; a create sent before the answer meets the instance's.
 */
export function addressBlocksCreate(check: AddressCheck): boolean {
  return check.state === "refused";
}

/**
 * The check of an address as it is typed: asked once the typing pauses, and only the answer
 * for the address shown counts. Without `checkName` nothing is asked.
 */
export function useAddressCheck(checkName: CheckName | undefined, name: string): AddressCheck {
  const { locale, t } = useTranslation();
  const [answer, setAnswer] = useState<{ name: string; check: AddressCheck }>();
  // The caller hands a new function on every render; the check follows the name alone.
  const check = useRef(checkName);
  check.current = checkName;
  const asks = checkName !== undefined && name !== "";
  useEffect(() => {
    const ask = check.current;
    if (!asks || ask === undefined) return;
    let current = true;
    const timer = window.setTimeout(() => {
      ask(name).then(
        (found) =>
          current && setAnswer({ name, check: addressCheckOf({ ok: true, found }, t, locale) }),
        (error: unknown) =>
          current && setAnswer({ name, check: addressCheckOf({ ok: false, error }, t, locale) })
      );
    }, BUILD_SEARCH_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [asks, name, t, locale]);
  if (!asks) return { state: "unchecked" };
  return answer?.name === name ? answer.check : { state: "checking" };
}
