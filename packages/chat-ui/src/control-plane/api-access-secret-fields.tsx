import { Check, Clipboard } from "lucide-react";
import { Button, InlineError } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { SecretCopyState, SecretField } from "./api-access-model";

export interface RevealedSecret {
  secret: string;
  serverUrl: string;
  credentialName: string;
}

/** Copies one credential field and reports the copied field, or that copying failed. */
export function copySecretField(
  field: SecretField,
  value: string,
  onResult: (state: SecretCopyState) => void,
  write: (value: string) => Promise<void> = copyText
): void {
  write(value).then(
    () => onResult({ copied: field }),
    () => onResult({ failed: true })
  );
}

export function SecretFields({
  secret,
  copyState,
  onCopy,
  onClose
}: {
  secret: RevealedSecret;
  copyState: SecretCopyState;
  onCopy(field: SecretField, value: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4">
      <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
        {t("apiAccessSecretOnce")}
      </p>
      <CopyField
        label={t("apiAccessServerUrl")}
        value={secret.serverUrl}
        copied={copyState.copied === "server"}
        onCopy={() => onCopy("server", secret.serverUrl)}
      />
      <CopyField
        label={t("apiAccessApiKey")}
        value={secret.secret}
        copied={copyState.copied === "key"}
        secret
        onCopy={() => onCopy("key", secret.secret)}
      />
      {copyState.failed ? <InlineError>{t("apiAccessCopyFailed")}</InlineError> : null}
      <div className="flex justify-end">
        <Button onClick={onClose}>{t("apiAccessDone")}</Button>
      </div>
    </div>
  );
}

function CopyField({
  label,
  value,
  copied,
  secret,
  onCopy
}: {
  label: string;
  value: string;
  copied: boolean;
  secret?: boolean;
  onCopy(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-w-0 gap-2">
        <code
          className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 text-xs"
          data-secret={secret ? "one-time" : undefined}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("settings.copyValue", { label })}
          onClick={onCopy}
        >
          {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}
