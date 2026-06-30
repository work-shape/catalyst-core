import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { createApiClient, type LocaleCode } from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "./api/workspace-query-keys";
import { signInWithEmail } from "./auth-client";
import { useTranslation } from "./i18n";
import { LocaleSelector } from "./locale-selector";
import {
  applyDocumentThemeMode,
  createThemeStyle,
  readSystemThemeMode,
  resolveThemeModePreference
} from "./theme";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";

const DEFAULT_LOGIN_LOCALES: LocaleCode[] = ["en", "de"];

export function LoginPanel({
  apiBaseUrl,
  localePreference,
  fallbackLocale,
  onLocaleChange,
  manageDocumentTitle,
  onSignedIn
}: {
  apiBaseUrl: string;
  localePreference: LocaleCode | undefined;
  fallbackLocale: LocaleCode;
  onLocaleChange(locale: LocaleCode): void;
  manageDocumentTitle?: boolean;
  onSignedIn: () => void;
}) {
  const { t, localeName } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [systemThemeMode, setSystemThemeMode] = useState(() => readSystemThemeMode());
  const client = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const brandingQuery = useQuery({
    queryKey: workspaceQueryKeys.branding(apiBaseUrl, localePreference),
    queryFn: () => client.branding(localePreference),
    retry: false
  });
  const branding = brandingQuery.data;
  const clientName = branding?.clientName ?? "Vivd Catalyst";
  const logoUrl = branding?.logoUrl;
  const logoUrlDark = branding?.logoUrlDark;
  const invertLogoOnDark = Boolean(branding?.logoInvertOnDark && !logoUrlDark);
  const activeLocale = branding?.localization.locale ?? fallbackLocale;
  const supportedLocales = branding?.localization.supportedLocales ?? DEFAULT_LOGIN_LOCALES;
  const resolvedThemeMode = resolveThemeModePreference(branding?.defaultThemeMode, systemThemeMode);
  const themeStyle = createThemeStyle(branding, resolvedThemeMode);

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
    applyDocumentThemeMode(resolvedThemeMode);
  }, [resolvedThemeMode]);

  useEffect(() => {
    if (!manageDocumentTitle || !branding?.title) {
      return undefined;
    }
    const previousTitle = document.title;
    document.title = branding.title;
    return () => {
      if (document.title === branding.title) {
        document.title = previousTitle;
      }
    };
  }, [branding?.title, manageDocumentTitle]);

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

  return (
    <main
      className="relative grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground"
      aria-label={t("signIn")}
      style={themeStyle}
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
          ) : (
            <div className="grid size-11 place-items-center rounded-lg border bg-card text-primary">
              <ShieldCheck size={22} aria-hidden="true" />
            </div>
          )}
          <CardTitle className="leading-tight">{t("signInTo", { clientName })}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onSubmit}>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>{t("email")}</span>
              <Input
                autoComplete="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span>{t("password")}</span>
              <Input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending || !email || !password}>
              {pending ? t("signingIn") : t("signIn")}
            </Button>
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
    </main>
  );
}
