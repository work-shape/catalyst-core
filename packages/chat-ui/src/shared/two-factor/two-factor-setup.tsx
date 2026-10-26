import {
  startTwoFactorSetup,
  verifySecondFactor,
  type AuthResult,
  type SecondFactorKind,
  type TwoFactorSetup
} from "@work-shape/catalyst-api-client";
import {
  Button,
  Field,
  FormNotice,
  Input,
  KeyValue,
  KeyValueList,
  QrCode
} from "@work-shape/catalyst-ui";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation, type TranslationContextValue } from "../i18n";

/** How long the copy button of the backup codes says it copied. */
const COPIED_MS = 2000;

/**
 * What a refused code or password says. A lock and a used-up challenge are said apart from a
 * wrong code, because only a new sign-in or the wait helps there.
 */
export function twoFactorRefusal(
  result: AuthResult,
  kind: SecondFactorKind | "password",
  t: TranslationContextValue["t"]
): string {
  if (result.code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return t("twoFactor.locked");
  }
  if (result.status === 429) {
    return t("twoFactor.rateLimited");
  }
  if (
    result.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
    result.code === "INVALID_TWO_FACTOR_COOKIE"
  ) {
    return t("twoFactor.challengeExpired");
  }
  if (kind === "password") {
    return result.code === "INVALID_PASSWORD"
      ? t("twoFactor.passwordWrong")
      : (result.message ?? t("tryAgain"));
  }
  return kind === "backup" ? t("twoFactor.backupCodeInvalid") : t("twoFactor.codeInvalid");
}

/** The key of an `otpauth://` address in groups of four, for typing it into an app by hand. */
function readableKey(totpUri: string): string {
  const secret = new URL(totpUri).searchParams.get("secret") ?? "";
  return secret.match(/.{1,4}/gu)?.join(" ") ?? "";
}

/** The ten backup codes, shown once, with copy, download and the step that ends the setup. */
export function BackupCodes({
  codes,
  accountName,
  onDone
}: {
  codes: string[];
  /** Names the account in the downloaded file. */
  accountName: string;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timeout);
  }, [copied]);

  function download() {
    const file = new Blob(
      [`${t("twoFactor.codesFileHeading", { name: accountName })}\n\n${text}\n`],
      {
        type: "text/plain"
      }
    );
    const href = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = href;
    link.download = "backup-codes.txt";
    link.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="grid gap-4">
      <p className="text-body text-muted-foreground">{t("twoFactor.backupCodesNote")}</p>
      <ul
        className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-4 py-3 font-mono text-body"
        aria-label={t("twoFactor.backupCodesTitle")}
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false)
            );
          }}
        >
          {copied ? t("twoFactor.codesCopied") : t("twoFactor.copyCodes")}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={download}>
          {t("twoFactor.downloadCodes")}
        </Button>
      </div>
      {onDone ? (
        <Button type="button" onClick={onDone}>
          {t("twoFactor.savedCodes")}
        </Button>
      ) : null}
    </div>
  );
}

type SetupStep =
  | { step: "password" }
  | { step: "scan"; setup: TwoFactorSetup }
  | { step: "codes"; backupCodes: string[] };

/**
 * Sets up two-factor sign-in: the password, the QR code with its key as text, the first code
 * from the app, then the backup codes once. The factor is on from the first code; `onDone`
 * follows the person's confirmation that the codes are saved.
 */
export function TwoFactorSetupFlow({
  apiBaseUrl,
  accountName,
  onDone,
  onCancel
}: {
  apiBaseUrl: string;
  accountName: string;
  onDone(): void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<SetupStep>({ step: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  /** Runs one step; a call that does not reach the instance says to try again. */
  function attempt(event: FormEvent, step: () => Promise<void>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    step().then(
      () => setPending(false),
      () => {
        setPending(false);
        setError(t("tryAgain"));
      }
    );
  }

  async function start() {
    const result = await startTwoFactorSetup({ apiBaseUrl, password });
    if (!result.ok || !result.setup) {
      setError(twoFactorRefusal(result, "password", t));
      return;
    }
    setPassword("");
    setState({ step: "scan", setup: result.setup });
  }

  async function confirm(setup: TwoFactorSetup) {
    const result = await verifySecondFactor({ apiBaseUrl, code, kind: "app" });
    if (!result.ok) {
      setError(twoFactorRefusal(result, "app", t));
      return;
    }
    setCode("");
    setState({ step: "codes", backupCodes: setup.backupCodes });
  }

  const cancel = onCancel ? (
    <Button type="button" variant="ghost" onClick={onCancel}>
      {t("twoFactor.cancelSetup")}
    </Button>
  ) : null;
  const notice = error ? <FormNotice tone="error">{error}</FormNotice> : null;

  if (state.step === "codes") {
    return (
      <div className="grid gap-4">
        <h3 className="text-title-sm">{t("twoFactor.backupCodesTitle")}</h3>
        <BackupCodes codes={state.backupCodes} accountName={accountName} onDone={onDone} />
      </div>
    );
  }

  if (state.step === "scan") {
    const { setup } = state;
    return (
      <form className="grid gap-4" onSubmit={(event) => attempt(event, () => confirm(setup))}>
        <p className="text-body text-muted-foreground">{t("twoFactor.scan")}</p>
        <div className="flex justify-center">
          <QrCode value={setup.totpUri} label={t("twoFactor.qrLabel")} size={176} />
        </div>
        <KeyValueList layout="stacked">
          <KeyValue
            label={t("twoFactor.key")}
            copyValue={readableKey(setup.totpUri).replaceAll(" ", "")}
          >
            <span className="font-mono">{readableKey(setup.totpUri)}</span>
          </KeyValue>
        </KeyValueList>
        <Field label={t("twoFactor.code")}>
          <Input
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
              setError(undefined);
            }}
          />
        </Field>
        {notice}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={pending} disabled={code.trim().length < 6}>
            {t("twoFactor.confirmCode")}
          </Button>
          {cancel}
        </div>
      </form>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => attempt(event, start)}>
      <p className="text-body text-muted-foreground">{t("twoFactor.passwordStep")}</p>
      <Field label={t("password")}>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.currentTarget.value);
            setError(undefined);
          }}
        />
      </Field>
      {notice}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} disabled={!password}>
          {t("twoFactor.continue")}
        </Button>
        {cancel}
      </div>
    </form>
  );
}
