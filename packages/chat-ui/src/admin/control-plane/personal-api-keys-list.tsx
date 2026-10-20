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
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { apiErrorMessage } from "../../shared/workspace-utils";
import { copyStateFor, type RecordedSecretCopy } from "./api-access-model";
import { copySecretField, SecretFields, type RevealedSecret } from "./api-access-secret-fields";
import { formatMomentShort } from "../../shared/locale-format";
import { actionLabel } from "../access/right-words";
import {
  keysSharingAName,
  personalKeyScopeParts,
  personalKeyStart,
  personalKeyState,
  type PersonalKeyState
} from "./personal-api-keys-model";

const stateTone = { active: "success", revoked: "neutral", expired: "neutral" } as const;

/**
 * What a scope of a key allows, as the rights screens name its action, with the workspace and
 * the asset it is limited to: "Agenten bearbeiten in Steuern". A workspace the reader is not
 * shown is named by its id.
 */
function scopeLabel(
  scope: string,
  t: TranslationContextValue["t"],
  workspaceName: (id: string) => string | undefined
): string {
  const { action, workspaceId, assetName } = personalKeyScopeParts(scope);
  const right = actionLabel(action, t);
  if (workspaceId === undefined) return right;
  const workspace = workspaceName(workspaceId) ?? workspaceId;
  return assetName === undefined
    ? t("personalApiKeys.scopeLimited", { right, workspace })
    : t("personalApiKeys.scopeLimitedAsset", { right, asset: assetName, workspace });
}

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
 * on the instance's list of every person's keys. A key is named by its name; how it starts is
 * said only where its owner holds another key of the same name.
 */
export function PersonalApiKeysTable({
  keys,
  loading,
  showOwner = false,
  revoking,
  onRevoke,
  revokeProblem,
  workspaceName = () => undefined
}: {
  keys: readonly PersonalApiKey[];
  loading: boolean;
  showOwner?: boolean;
  revoking: boolean;
  /** Left out for a reader who may not revoke. A failure is thrown and said in the dialog. */
  onRevoke?(key: PersonalApiKey): Promise<unknown>;
  /** What the dialog says about a thrown failure; by default its message. */
  revokeProblem?(error: unknown): KeyProblem;
  /** The name of a workspace a scope is limited to, where the reader is shown it. */
  workspaceName?(id: string): string | undefined;
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

  const sharingAName = keysSharingAName(keys);
  const close = () => {
    setToRevoke(undefined);
    setRevokeError(undefined);
  };

  return (
    <>
      {/* Name, status and Revoke never fold: Created folds first, then Last used, Expires,
          what the key may do and the owner, each into the details under the name. Status and
          Revoke take only their content's width, so the name and its details get the rest. */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("apiAccessName")}</TableHead>
            {showOwner ? <TableHead priority={1}>{t("personalApiKeys.owner")}</TableHead> : null}
            <TableHead priority={2}>{t("personalApiKeys.actions")}</TableHead>
            <TableHead priority={3}>{t("apiAccessExpires")}</TableHead>
            <TableHead priority={4}>{t("apiAccessLastUsed")}</TableHead>
            <TableHead priority={5}>{t("apiAccessCreatedAt")}</TableHead>
            <TableHead className="w-0">{t("apiAccessStatus")}</TableHead>
            {onRevoke ? <TableHead className="w-0" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => {
            const state = personalKeyState(key);
            return (
              <TableRow key={key.id}>
                <TableCell rowDetail>
                  <span className="block font-medium wrap-anywhere">{key.name}</span>
                  {sharingAName.has(key.id) ? (
                    // A start has no spaces; it wraps anywhere rather than widen the column.
                    <span className="block text-caption text-muted-foreground wrap-anywhere">
                      {t("personalApiKeys.startsWith", { prefix: personalKeyStart(key.keyPrefix) })}
                    </span>
                  ) : null}
                </TableCell>
                {showOwner ? (
                  <TableCell>{key.ownerDisplayLabel ?? key.ownerUserId}</TableCell>
                ) : null}
                <TableCell>
                  {/* Muted on the span: a folded cell moves only its children under the name. */}
                  <span className="text-muted-foreground">
                    {key.scopes.map((scope) => scopeLabel(scope, t, workspaceName)).join(", ")}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatMomentShort(key.expiresAt, locale)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {key.lastUsedAt ? formatMomentShort(key.lastUsedAt, locale) : t("apiAccessNever")}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatMomentShort(key.createdAt, locale)}
                </TableCell>
                <TableCell>
                  <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                </TableCell>
                {onRevoke ? (
                  <TableCell className="text-right">
                    {state === "active" ? (
                      <Button
                        variant="outline"
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
