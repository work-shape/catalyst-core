import { useMutationState, useQueryClient } from "@tanstack/react-query";
import type { ApiClient, LocaleCode } from "@work-shape/catalyst-api-client";
import { isLocaleCode } from "@work-shape/catalyst-core";
import { useCallback } from "react";
import { useUpdateCurrentUserMutation } from "../../shared/api/workspace-mutations";
import { createTranslationContext } from "../../shared/i18n";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { apiErrorMessage } from "../../shared/workspace-utils";

/**
 * The language the interface asks the instance for: a choice still being saved, else the one
 * the signed-in account chose, else the one this browser keeps. Signed out, or for an account
 * that chose none, the browser's choice stands as it did before accounts kept one.
 */
export function chosenLocale(input: {
  saving: LocaleCode | undefined;
  account: LocaleCode | undefined;
  stored: LocaleCode | undefined;
}): LocaleCode | undefined {
  return input.saving ?? input.account ?? input.stored;
}

/** Which saves the language being saved is read from: the pending ones of this account. */
export function savingLocaleFilters(apiBaseUrl: string, userId: string) {
  return {
    mutationKey: workspaceQueryKeys.meUpdate(apiBaseUrl, userId),
    exact: true,
    status: "pending" as const
  };
}

/**
 * The language of the last choice among the inputs of an account's pending saves, oldest
 * first as the cache lists them: they are saved one after the other, so the last one stays.
 * A save of the name alone names no language.
 */
export function latestSavingLocale(inputs: readonly unknown[]): LocaleCode | undefined {
  return inputs
    .flatMap((input) =>
      typeof input === "object" &&
      input !== null &&
      "locale" in input &&
      typeof input.locale === "string" &&
      isLocaleCode(input.locale)
        ? [input.locale]
        : []
    )
    .at(-1);
}

/**
 * The language choice of the interface, kept with the signed-in account. A choice is kept in
 * the browser too, for the sign-in page; signed in, it is saved to the account, and what the
 * instance writes in the reader's language, such as a Workflow's publish question, is read
 * again.
 */
export function useAccountLocale(input: {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  /** The signed-in account, once it arrived; nothing signed out. */
  account: { id: string; locale?: LocaleCode } | undefined;
  stored: LocaleCode | undefined;
  selectStored(locale: LocaleCode): void;
  onErrorMessage(message: string | undefined): void;
}): { localePreference: LocaleCode | undefined; selectLocale(locale: LocaleCode): void } {
  const { apiBaseUrl, authScope, client, selectStored, onErrorMessage } = input;
  const userId = input.account?.id;
  const queryClient = useQueryClient();
  // Signed out there is no account to save to; the empty id names no account's saves.
  const { mutateAsync } = useUpdateCurrentUserMutation({
    apiBaseUrl,
    authScope,
    client,
    userId: userId ?? ""
  });
  const saving = latestSavingLocale(
    useMutationState({
      filters: savingLocaleFilters(apiBaseUrl, userId ?? ""),
      select: (mutation) => mutation.state.variables
    })
  );
  const selectLocale = useCallback(
    (locale: LocaleCode) => {
      selectStored(locale);
      if (userId === undefined) return;
      mutateAsync({ locale })
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.assets(apiBaseUrl, authScope)
          })
        )
        // Said in the language just picked, which the page already shows.
        .catch((error: unknown) =>
          onErrorMessage(
            apiErrorMessage(error, createTranslationContext(locale).t("languageNotSaved"))
          )
        );
    },
    [apiBaseUrl, authScope, mutateAsync, onErrorMessage, queryClient, selectStored, userId]
  );
  return {
    localePreference: chosenLocale({
      saving: userId === undefined ? undefined : saving,
      account: input.account?.locale,
      stored: input.stored
    }),
    selectLocale
  };
}
