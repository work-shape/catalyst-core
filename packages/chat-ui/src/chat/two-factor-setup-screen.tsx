import { Button, Card, CardContent, CardHeader, CardTitle } from "@work-shape/catalyst-ui";
import { useTranslation } from "../shared/i18n";
import { TwoFactorSetupFlow } from "../shared/two-factor/two-factor-setup";

/**
 * TWO-FACTOR-1. What a person signed in with a password sees, and all they see, on an instance
 * that requires two-factor sign-in until they set it up. The first code replaces the session, so
 * the screen ends signed in; signing out is the other way off it.
 */
export function TwoFactorSetupScreen({
  apiBaseUrl,
  accountName,
  signingOut,
  onDone,
  onSignOut
}: {
  apiBaseUrl: string;
  accountName: string;
  signingOut: boolean;
  onDone(): void;
  onSignOut(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-dvh w-full place-items-center bg-sidebar p-5 text-foreground">
      <Card className="w-full max-w-[420px]">
        <CardHeader className="gap-2">
          <CardTitle className="leading-tight">{t("twoFactor.setupTitle")}</CardTitle>
          <p className="text-body text-muted-foreground">{t("twoFactor.setupRequired")}</p>
        </CardHeader>
        <CardContent className="grid gap-4">
          <TwoFactorSetupFlow apiBaseUrl={apiBaseUrl} accountName={accountName} onDone={onDone} />
          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <span className="min-w-0 truncate text-body text-muted-foreground">{accountName}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={signingOut}
              onClick={onSignOut}
            >
              {t("signOut")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
