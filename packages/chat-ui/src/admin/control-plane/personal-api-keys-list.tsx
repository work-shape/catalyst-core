import { useState } from "react";
import type { PersonalApiKey } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  InlineError,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { apiErrorMessage } from "../../shared/workspace-utils";
import { copyStateFor, type RecordedSecretCopy } from "./api-access-model";
import { copySecretField, SecretFields, type RevealedSecret } from "./api-access-secret-fields";
import { formatDateTime } from "../../shared/locale-format";
import { personalKeyState, type PersonalKeyState } from "./personal-api-keys-model";

const stateTone = { active: "accent", revoked: "neutral", expired: "neutral" } as const;

/** Why a key could not be read, issued or revoked. A refusal needs somebody with more rights. */
export interface KeyProblem {
  message: string;
  refused: boolean;
}

/** A refusal is information, since trying again does not help; a failure is an error. */
export function KeyProblemNotice({ problem }: { problem: KeyProblem }) {
  return problem.refused ? (
    <Banner tone="info" className="w-full">
      {problem.message}
    </Banner>
  ) : (
    <InlineError className="w-full">{problem.message}</InlineError>
  );
}

/**
 * Personal API keys as a table, with Revoke behind one question. The owner's column is shown
 * on the instance's list of every person's keys.
 */
export function PersonalApiKeysTable({
  keys,
  loading,
  showOwner = false,
  revoking,
  onRevoke,
  revokeProblem
}: {
  keys: readonly PersonalApiKey[];
  loading: boolean;
  showOwner?: boolean;
  revoking: boolean;
  /** Left out for a reader who may not revoke. A failure is thrown and said in the dialog. */
  onRevoke?(key: PersonalApiKey): Promise<unknown>;
  /** What the dialog says about a thrown failure; by default its message. */
  revokeProblem?(error: unknown): KeyProblem;
}) {
  const { t, locale } = useTranslation();
  const [toRevoke, setToRevoke] = useState<PersonalApiKey>();
  const [revokeError, setRevokeError] = useState<KeyProblem>();
  const stateLabel: Record<PersonalKeyState, string> = {
    active: t("apiAccessActive"),
    revoked: t("apiAccessRevoked"),
    expired: t("apiAccessExpired")
  };

  if (loading) return <SkeletonList rows={3} />;
  if (keys.length === 0) {
    return <EmptyState layout="inline">{t("personalApiKeys.empty")}</EmptyState>;
  }

  const close = () => {
    setToRevoke(undefined);
    setRevokeError(undefined);
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {showOwner ? <TableHead>{t("personalApiKeys.owner")}</TableHead> : null}
            <TableHead>{t("apiAccessName")}</TableHead>
            <TableHead>{t("apiAccessKeyPrefix")}</TableHead>
            <TableHead>{t("apiAccessScopes")}</TableHead>
            <TableHead>{t("apiAccessCreatedAt")}</TableHead>
            <TableHead>{t("apiAccessExpires")}</TableHead>
            <TableHead>{t("apiAccessLastUsed")}</TableHead>
            <TableHead>{t("apiAccessStatus")}</TableHead>
            {onRevoke ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => {
            const state = personalKeyState(key);
            return (
              <TableRow key={key.id}>
                {showOwner ? (
                  <TableCell>{key.ownerDisplayLabel ?? key.ownerUserId}</TableCell>
                ) : null}
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell>
                  <code className="text-caption">{key.keyPrefix}…</code>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {key.scopes.map((scope) => (
                      <Badge key={scope}>{scope}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(key.createdAt, locale)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(key.expiresAt, locale)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {key.lastUsedAt ? formatDateTime(key.lastUsedAt, locale) : t("apiAccessNever")}
                </TableCell>
                <TableCell>
                  <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                </TableCell>
                {onRevoke ? (
                  <TableCell className="text-right">
                    {state === "active" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoking}
                        onClick={() => setToRevoke(key)}
                      >
                        {t("apiAccessRevoke")}
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {onRevoke && toRevoke ? (
        // The question of a confirm dialog, until it is refused: then the answer stands and only
        // Close is left, since asking again would be refused again.
        <Dialog
          open
          size="sm"
          title={t("personalApiKeys.revokeTitle", { name: toRevoke.name })}
          onClose={close}
          footer={
            revokeError?.refused ? (
              <Button type="button" variant="outline" onClick={close}>
                {t("close")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={revoking} onClick={close}>
                  {t("cancel")}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  loading={revoking}
                  onClick={() => {
                    setRevokeError(undefined);
                    onRevoke(toRevoke).then(close, (caught: unknown) =>
                      setRevokeError(
                        revokeProblem?.(caught) ?? {
                          message:
                            apiErrorMessage(caught, t("settings.requestFailed")) ??
                            t("settings.requestFailed"),
                          refused: false
                        }
                      )
                    );
                  }}
                >
                  {t("apiAccessRevoke")}
                </Button>
              </>
            )
          }
        >
          <div className="grid gap-4">
            <p className="text-body text-muted-foreground">{t("apiAccessRevokeDescription")}</p>
            {revokeError ? <KeyProblemNotice problem={revokeError} /> : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The new key, shown this once with the instance's address, as the CLI and a script take
 * them: `CATALYST_API_KEY`. Closing the dialog drops it.
 */
export function PersonalKeyRevealDialog({
  secret,
  onClose
}: {
  secret: RevealedSecret;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [recorded, setRecorded] = useState<RecordedSecretCopy>();
  return (
    <Dialog
      open
      title={t("personalApiKeys.created", { name: secret.credentialName })}
      description={t("personalApiKeys.createdDescription")}
      onClose={onClose}
    >
      <SecretFields
        secret={secret}
        copyState={copyStateFor(recorded, secret.secret)}
        onCopy={(field, value) =>
          copySecretField(field, value, (state) => setRecorded({ secret: secret.secret, state }))
        }
        onClose={onClose}
      />
    </Dialog>
  );
}
