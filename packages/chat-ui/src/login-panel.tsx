import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createApiClient, type LocaleCode } from "@vivd-catalyst/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Input,
  UiRoot
} from "@vivd-catalyst/ui";
import { workspaceQueryKeys } from "./api/workspace-query-keys";
import { signInWithEmail } from "./api/auth-client";
import { useTranslation } from "./i18n";
import { LocaleSelector } from "./locale-selector";
import { readSystemThemeMode, resolveThemeModePreference, type ResolvedThemeMode } from "./theme";
import { uiLabelsFor } from "./ui-labels";
import { createEnvironmentDocumentTitle } from "./workspace-utils";

const DEFAULT_LOGIN_LOCALES: LocaleCode[] = ["en", "de"];

type LoginMode = "signIn" | "requestReset" | "setPassword";

export function LoginPanel({
  apiBaseUrl,
  localePreference,
  fallbackLocale,
  onLocaleChange,
  manageDocumentTitle,
  passwordSetupToken,
  onPasswordSetupClosed,
  onThemeModeChange,
  onSignedIn
}: {
  apiBaseUrl: string;
  localePreference: LocaleCode | undefined;
  fallbackLocale: LocaleCode;
  onLocaleChange(locale: LocaleCode): void;
  manageDocumentTitle?: boolean;
  /** Token from an emailed link; shows the set-password form instead of sign-in. */
  passwordSetupToken?: string;
  onPasswordSetupClosed?: () => void;
  onThemeModeChange?: (mode: ResolvedThemeMode) => void;
  onSignedIn: () => void;
}) {
  const { t, locale, localeName } = useTranslation();
  const [mode, setMode] = useState<LoginMode>(passwordSetupToken ? "setPassword" : "signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [systemThemeMode, setSystemThemeMode] = useState(() => readSystemThemeMode());
  const client = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const brandingQuery = useQuery({
    queryKey: workspaceQueryKeys.branding(apiBaseUrl, localePreference),
    queryFn: () => client.branding.get(localePreference),
    retry: false
  });
  const branding = brandingQuery.data;
  const clientName = branding?.clientName;
  const clientInitial = clientName?.trim().charAt(0).toLocaleUpperCase();
  const logoUrl = branding?.logoUrl;
  const logoUrlDark = branding?.logoUrlDark;
  const invertLogoOnDark = Boolean(branding?.logoInvertOnDark && !logoUrlDark);
  const activeLocale = branding?.localization.locale ?? fallbackLocale;
  const supportedLocales = branding?.localization.supportedLocales ?? DEFAULT_LOGIN_LOCALES;
  const resolvedThemeMode = resolveThemeModePreference(branding?.defaultThemeMode, systemThemeMode);
  const theme = resolvedThemeMode === "dark" ? branding?.darkTheme : branding?.theme;
  const documentTitle = branding
    ? createEnvironmentDocumentTitle(branding.title, branding.environment)
    : undefined;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }

    function onChange(event: MediaQueryListEvent) {
      setSystemThemeMode(event.matches ? "dark" : "light");
    }

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    onThemeModeChange?.(resolvedThemeMode);
  }, [onThemeModeChange, resolvedThemeMode]);

  useEffect(() => {
    if (!manageDocumentTitle || !documentTitle) {
      return undefined;
    }
    const previousTitle = document.title;
    document.title = documentTitle;
    return () => {
      if (document.title === documentTitle) {
        document.title = previousTitle;
      }
    };
  }, [documentTitle, manageDocumentTitle]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const result = await signInWithEmail({
      apiBaseUrl,
      email,
      password
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message ?? t("signInFailed"));
      return;
    }
    onSignedIn();
  }

  function showMode(nextMode: LoginMode) {
    setMode(nextMode);
    setPassword("");
    setError(undefined);
    setNotice(undefined);
  }

  function closePasswordSetup(nextNotice?: string) {
    onPasswordSetupClosed?.();
    showMode("signIn");
    setNotice(nextNotice);
  }

  async function onRequestReset(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await client.passwordSetup.requestReset({ email }, activeLocale);
      showMode("signIn");
      setNotice(t("passwordResetSent"));
    } catch {
      setError(t("tryAgain"));
    } finally {
      setPending(false);
    }
  }

  async function onSetPassword(event: FormEvent) {
    event.preventDefault();
    if (!passwordSetupToken) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await client.passwordSetup.complete({ token: passwordSetupToken, password });
      closePasswordSetup(t("passwordSetupDone"));
    } catch {
      setError(t("passwordSetupFailed"));
    } finally {
      setPending(false);
    }
  }

  const title =
    mode === "setPassword"
      ? t("passwordSetupTitle")
      : mode === "requestReset"
        ? t("passwordResetTitle")
        : clientName
          ? t("signInTo", { clientName })
          : t("signIn");

  return (
    <UiRoot
      as="main"
      theme={theme}
      mode={resolvedThemeMode}
      labels={uiLabelsFor(locale)}
      className={cn(
        "relative grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground",
        // `scheme-dark` makes the browser paint autofilled inputs in its dark palette.
        resolvedThemeMode === "dark" && "scheme-dark"
      )}
      aria-label={t("signIn")}
    >
      <Card className="w-full max-w-[380px]">
        <CardHeader className="gap-4">
          {logoUrl ? (
            <div
              className={cn(
                "mx-auto flex h-14 w-full max-w-[230px] items-center justify-center rounded-lg border px-3",
                logoUrlDark || invertLogoOnDark ? "bg-card dark:bg-transparent" : "bg-white"
              )}
            >
              <img
                className={cn(
                  "max-h-10 w-full object-contain",
                  logoUrlDark && "dark:hidden",
                  invertLogoOnDark && "dark:invert"
                )}
                src={logoUrl}
                alt=""
              />
              {logoUrlDark ? (
                <img
                  className="hidden max-h-10 w-full object-contain dark:block"
                  src={logoUrlDark}
                  alt=""
                />
              ) : null}
            </div>
          ) : clientInitial ? (
            <div className="grid size-11 place-items-center rounded-lg border bg-card text-primary">
              <span className="text-base font-semibold" aria-hidden="true">
                {clientInitial}
              </span>
            </div>
          ) : null}
          <CardTitle className="leading-tight">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={
              mode === "setPassword"
                ? onSetPassword
                : mode === "requestReset"
                  ? onRequestReset
                  : onSubmit
            }
          >
            {mode === "requestReset" ? (
              <p className="text-sm text-muted-foreground">{t("passwordResetDescription")}</p>
            ) : null}
            {notice ? (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" role="status">
                {notice}
              </p>
            ) : null}
            {mode !== "setPassword" ? (
              <label className="grid gap-1.5 text-sm font-medium">
                <span>{t("email")}</span>
                <Input
                  autoComplete="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            ) : null}
            {mode !== "requestReset" ? (
              <label className="grid gap-1.5 text-sm font-medium">
                <span>{mode === "setPassword" ? t("newPassword") : t("password")}</span>
                <Input
                  autoComplete={mode === "setPassword" ? "new-password" : "current-password"}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : null}
            {mode === "setPassword" && password.length > 0 && password.length < 8 ? (
              <p className="text-sm text-muted-foreground">{t("newPasswordTooShort")}</p>
            ) : null}
            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {mode === "setPassword" ? (
              <Button type="submit" disabled={pending || password.length < 8}>
                {pending ? t("saving") : t("passwordSetupSubmit")}
              </Button>
            ) : mode === "requestReset" ? (
              <Button type="submit" disabled={pending || !email}>
                {t("passwordResetSend")}
              </Button>
            ) : (
              <Button type="submit" disabled={pending || !email || !password}>
                {pending ? t("signingIn") : t("signIn")}
              </Button>
            )}
            {mode === "signIn" && branding?.passwordResetEnabled ? (
              <Button type="button" variant="ghost" onClick={() => showMode("requestReset")}>
                {t("passwordResetForgot")}
              </Button>
            ) : null}
            {mode !== "signIn" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => (mode === "setPassword" ? closePasswordSetup() : showMode("signIn"))}
              >
                {t("passwordSetupBack")}
              </Button>
            ) : null}
          </form>
          <div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
            <span className="text-sm text-muted-foreground">{localeName(activeLocale)}</span>
            <LocaleSelector
              locales={supportedLocales}
              selectedLocale={activeLocale}
              onSelectLocale={onLocaleChange}
            />
          </div>
        </CardContent>
      </Card>
    </UiRoot>
  );
}
