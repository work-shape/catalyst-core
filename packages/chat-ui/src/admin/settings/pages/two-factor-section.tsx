import { useQueryClient } from "@tanstack/react-query";
import {
  forgetTrustedBrowsers,
  regenerateBackupCodes,
  turnOffTwoFactor
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  Field,
  FormNotice,
  Input,
  Section,
  type FormNoticeTone
} from "@work-shape/catalyst-ui";
import { useState } from "react";
import { workspaceQueryKeys } from "../../../shared/api/workspace-query-keys";
import { useTranslation } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";
import {
  BackupCodes,
  twoFactorRefusal,
  TwoFactorSetupFlow
} from "../../../shared/two-factor/two-factor-setup";

type Notice = { tone: FormNoticeTone; text: string };

/**
 * You > Security: two-factor sign-in of an account with a password (TWO-FACTOR-1). Set up, new
 * backup codes, forgetting trusted browsers and turning it off. A person moves to a new phone by
 * turning it off and setting it up again.
 */
export function TwoFactorSection() {
  const { t } = useTranslation();
  const { apiBaseUrl, user } = useSettingsPage();
  const queryClient = useQueryClient();
  const [settingUp, setSettingUp] = useState(false);
  const [password, setPassword] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | undefined>();
  const [notice, setNotice] = useState<Notice | undefined>();
  const [pending, setPending] = useState<"regenerate" | "turnOff" | "forget" | undefined>();
  const state = user.twoFactor;
  if (!state) {
    return null;
  }
  const accountName = user.email ?? user.displayLabel;

  function refreshAccount() {
    queryClient
      .invalidateQueries({ queryKey: workspaceQueryKeys.me(apiBaseUrl) })
      .catch(() => undefined);
  }

  /** Runs one change; a call that does not reach the instance says to try again. */
  function attempt(action: NonNullable<typeof pending>, change: () => Promise<void>) {
    setPending(action);
    setNotice(undefined);
    change().then(
      () => setPending(undefined),
      () => {
        setPending(undefined);
        setNotice({ tone: "error", text: t("tryAgain") });
      }
    );
  }

  async function regenerate() {
    const result = await regenerateBackupCodes({ apiBaseUrl, password });
    if (!result.ok || !result.backupCodes) {
      setNotice({ tone: "error", text: twoFactorRefusal(result, "password", t) });
      return;
    }
    setPassword("");
    setNewCodes(result.backupCodes);
    setNotice({ tone: "success", text: t("twoFactor.regenerateDone") });
  }

  async function turnOff() {
    const result = await turnOffTwoFactor({ apiBaseUrl, password });
    if (!result.ok) {
      setNotice({ tone: "error", text: twoFactorRefusal(result, "password", t) });
      return;
    }
    setPassword("");
    setNewCodes(undefined);
    setNotice({ tone: "success", text: t("twoFactor.turnedOff") });
    refreshAccount();
  }

  async function forget() {
    const result = await forgetTrustedBrowsers(apiBaseUrl);
    setNotice(
      result.ok
        ? { tone: "success", text: t("twoFactor.forgetBrowsersDone") }
        : { tone: "error", text: result.message ?? t("tryAgain") }
    );
  }

  const noticeLine = notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null;

  return (
    <Section
      layout="stacked"
      title={t("twoFactor.title")}
      state={
        <Badge tone={state.enrolled ? "success" : "neutral"} dot>
          {state.enrolled ? t("twoFactor.on") : t("twoFactor.off")}
        </Badge>
      }
      description={state.enrolled ? t("twoFactor.onDescription") : t("twoFactor.offDescription")}
    >
      {!state.enrolled ? (
        settingUp ? (
          <TwoFactorSetupFlow
            apiBaseUrl={apiBaseUrl}
            accountName={accountName}
            onCancel={() => setSettingUp(false)}
            onDone={() => {
              setSettingUp(false);
              setNotice({ tone: "success", text: t("twoFactor.enabled") });
              refreshAccount();
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => {
                setNotice(undefined);
                setSettingUp(true);
              }}
            >
              {t("twoFactor.setUp")}
            </Button>
            {noticeLine}
          </div>
        )
      ) : (
        <div className="grid gap-5">
          {newCodes ? <BackupCodes codes={newCodes} accountName={accountName} /> : null}
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              attempt("regenerate", regenerate);
            }}
          >
            <Field
              label={t("twoFactor.passwordForChanges")}
              hint={state.required ? t("twoFactor.turnOffRequired") : undefined}
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value);
                  setNotice(undefined);
                }}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="secondary"
                loading={pending === "regenerate"}
                disabled={!password || pending !== undefined}
              >
                {t("twoFactor.regenerate")}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={pending === "turnOff"}
                disabled={!password || pending !== undefined}
                onClick={() => attempt("turnOff", turnOff)}
              >
                {t("twoFactor.turnOff")}
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              loading={pending === "forget"}
              disabled={pending !== undefined}
              onClick={() => attempt("forget", forget)}
            >
              {t("twoFactor.forgetBrowsers")}
            </Button>
          </div>
          {noticeLine}
        </div>
      )}
    </Section>
  );
}
