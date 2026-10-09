import { KeyRound, Pencil, Plus, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ApiCredential,
  ApiCredentialScope,
  CreateApiCredentialRequest,
  CreateApiCredentialResponse,
  CreateServicePrincipalRequest,
  LocaleCode,
  ServicePrincipalDetail,
  ServicePrincipalPermission,
  UpdateServicePrincipalRequest
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea
} from "@vivd-catalyst/ui";
import {
  constrainCredentialScopes,
  copyStateFor,
  DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS,
  expiryInputToIso,
  isCredentialActive,
  optionalTrimmedValue,
  scopesAllowedByPermissions,
  type RecordedSecretCopy
} from "./api-access-model";
import { copySecretField, SecretFields, type RevealedSecret } from "./api-access-secret-fields";
import { useTranslation } from "../i18n";

export interface ApiAccessPanelInput {
  canMutate: boolean;
  principals: ServicePrincipalDetail[];
  revealedCredential?: {
    secret: string;
    credentialName: string;
    serverUrl: string;
    authorityKey: string;
  };
  loading: boolean;
  mutating: boolean;
  error?: string;
  onCreatePrincipal(input: CreateServicePrincipalRequest): Promise<ServicePrincipalDetail>;
  onUpdatePrincipal(
    principalId: string,
    input: UpdateServicePrincipalRequest
  ): Promise<ServicePrincipalDetail>;
  onCreateCredential(
    principalId: string,
    input: CreateApiCredentialRequest
  ): Promise<CreateApiCredentialResponse>;
  onRevokeCredential(credentialId: string): Promise<ApiCredential>;
  onClearRevealedCredential(): void;
}

export function ApiAccessPanel({
  canMutate,
  principals,
  revealedCredential,
  loading,
  mutating,
  error,
  onCreatePrincipal,
  onUpdatePrincipal,
  onCreateCredential,
  onRevokeCredential,
  onClearRevealedCredential
}: ApiAccessPanelInput) {
  const { t } = useTranslation();
  const [selectedPrincipalId, setSelectedPrincipalId] = useState<string>();
  const [principalDialog, setPrincipalDialog] = useState<"create" | "edit">();
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [credentialToRevoke, setCredentialToRevoke] = useState<ApiCredential>();
  const [actionError, setActionError] = useState<string>();

  const selectedPrincipal =
    principals.find(({ principal }) => principal.id === selectedPrincipalId) ?? principals[0];

  useEffect(() => {
    if (selectedPrincipal && selectedPrincipalId !== selectedPrincipal.principal.id) {
      setSelectedPrincipalId(selectedPrincipal.principal.id);
    }
  }, [selectedPrincipal, selectedPrincipalId]);

  useEffect(() => {
    if (!canMutate) {
      setPrincipalDialog(undefined);
      setCredentialDialogOpen(false);
      setCredentialToRevoke(undefined);
    }
  }, [canMutate]);

  return (
    <>
      <PageHeader
        title={t("settings.apiAccess")}
        description={t("apiAccessDescription")}
        primaryAction={
          canMutate ? (
            <Button onClick={() => setPrincipalDialog("create")}>
              <Plus aria-hidden="true" />
              {t("apiAccessCreatePrincipal")}
            </Button>
          ) : undefined
        }
      />
      <div className="grid min-w-0 content-start gap-4">
        {error || actionError ? <Banner tone="danger">{actionError ?? error}</Banner> : null}

        <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(17rem,0.72fr)_minmax(28rem,1.28fr)]">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">{t("apiAccessServicePrincipals")}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {t("apiAccessServicePrincipalsDescription")}
              </p>
            </CardHeader>
            <CardContent className="p-2 pt-1">
              {loading ? (
                <SkeletonList rows={3} className="px-2" />
              ) : principals.length === 0 ? (
                <EmptyState
                  layout="inline"
                  icon={<ShieldCheck aria-hidden="true" />}
                  action={
                    canMutate ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPrincipalDialog("create")}
                      >
                        <Plus aria-hidden="true" />
                        {t("apiAccessCreatePrincipal")}
                      </Button>
                    ) : undefined
                  }
                >
                  {t("apiAccessEmpty")} {t("apiAccessEmptyDescription")}
                </EmptyState>
              ) : (
                <ul className="grid gap-1">
                  {principals.map((detail) => {
                    const selected = selectedPrincipal?.principal.id === detail.principal.id;
                    return (
                      <li key={detail.principal.id}>
                        <button
                          type="button"
                          aria-current={selected ? "page" : undefined}
                          className={`grid w-full gap-1 rounded-md px-3 py-2.5 text-left transition-colors ${selected ? "bg-accent" : "hover:bg-muted/60"}`}
                          onClick={() => setSelectedPrincipalId(detail.principal.id)}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium">
                              {detail.principal.displayLabel}
                            </span>
                            <Badge
                              tone={detail.principal.status === "active" ? "accent" : "neutral"}
                            >
                              {detail.principal.status === "active"
                                ? t("apiAccessActive")
                                : t("apiAccessDisabled")}
                            </Badge>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {detail.credentials.length}{" "}
                            {detail.credentials.length === 1
                              ? t("apiAccessCredential")
                              : t("apiAccessCredentials")}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {selectedPrincipal ? (
            <PrincipalDetail
              detail={selectedPrincipal}
              mutating={mutating}
              canMutate={canMutate}
              onEdit={() => setPrincipalDialog("edit")}
              onCreateCredential={() => setCredentialDialogOpen(true)}
              onRevokeCredential={setCredentialToRevoke}
            />
          ) : null}
        </div>

        {principalDialog && canMutate ? (
          <PrincipalDialog
            mode={principalDialog}
            detail={principalDialog === "edit" ? selectedPrincipal : undefined}
            pending={mutating}
            onClose={() => setPrincipalDialog(undefined)}
            onSubmit={async (input) => {
              setActionError(undefined);
              try {
                const detail =
                  principalDialog === "edit" && selectedPrincipal
                    ? await onUpdatePrincipal(selectedPrincipal.principal.id, input)
                    : await onCreatePrincipal(input as CreateServicePrincipalRequest);
                setSelectedPrincipalId(detail.principal.id);
                setPrincipalDialog(undefined);
              } catch (caught) {
                setActionError(errorMessage(caught, t("settings.requestFailed")));
              }
            }}
          />
        ) : null}

        {credentialDialogOpen && canMutate ? (
          <CredentialDialog
            open={credentialDialogOpen}
            detail={selectedPrincipal}
            pending={mutating}
            onClose={() => setCredentialDialogOpen(false)}
            onSubmit={async (input) => {
              if (!selectedPrincipal) return;
              setActionError(undefined);
              try {
                await onCreateCredential(selectedPrincipal.principal.id, input);
                setCredentialDialogOpen(false);
              } catch (caught) {
                setActionError(errorMessage(caught, t("settings.requestFailed")));
              }
            }}
          />
        ) : null}

        {canMutate && revealedCredential ? (
          <SecretDialog secret={revealedCredential} onClose={onClearRevealedCredential} />
        ) : null}

        {credentialToRevoke && canMutate ? (
          <Dialog
            open={Boolean(credentialToRevoke)}
            title={t("apiAccessRevokeCredential")}
            onClose={() => setCredentialToRevoke(undefined)}
          >
            <p className="text-sm text-muted-foreground">{t("apiAccessRevokeDescription")}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCredentialToRevoke(undefined)}>
                {t("cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={mutating}
                onClick={async () => {
                  if (!credentialToRevoke) return;
                  setActionError(undefined);
                  try {
                    await onRevokeCredential(credentialToRevoke.id);
                    setCredentialToRevoke(undefined);
                  } catch (caught) {
                    setActionError(errorMessage(caught, t("settings.requestFailed")));
                  }
                }}
              >
                {t("apiAccessRevoke")}
              </Button>
            </div>
          </Dialog>
        ) : null}
      </div>
    </>
  );
}

function PrincipalDetail({
  detail,
  mutating,
  canMutate,
  onEdit,
  onCreateCredential,
  onRevokeCredential
}: {
  detail: ServicePrincipalDetail;
  mutating: boolean;
  canMutate: boolean;
  onEdit(): void;
  onCreateCredential(): void;
  onRevokeCredential(credential: ApiCredential): void;
}) {
  const { t, locale } = useTranslation();
  const { principal, credentials } = detail;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 p-4 pb-3">
        <div className="grid gap-1">
          <CardTitle className="text-base">{principal.displayLabel}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {principal.description ?? t("apiAccessNoDescription")}
          </p>
        </div>
        {canMutate ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            {t("apiAccessEdit")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-5 p-4 pt-0">
        <div className="flex flex-wrap gap-2">
          {principal.permissions.map((permission) => (
            <Badge key={permission}>{permission}</Badge>
          ))}
          {principal.permissions.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t("apiAccessNoGrants")}</span>
          ) : null}
        </div>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{t("apiAccessApiKeys")}</h3>
              <p className="text-xs text-muted-foreground">{t("apiAccessApiKeysDescription")}</p>
            </div>
            {canMutate ? (
              <Button
                size="sm"
                disabled={
                  mutating || principal.status !== "active" || principal.permissions.length === 0
                }
                onClick={onCreateCredential}
              >
                <KeyRound aria-hidden="true" />
                {t("apiAccessCreateCredential")}
              </Button>
            ) : null}
          </div>
          {credentials.length === 0 ? (
            <EmptyState layout="inline">{t("apiAccessNoCredentials")}</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("apiAccessName")}</TableHead>
                  <TableHead>{t("apiAccessKeyPrefix")}</TableHead>
                  <TableHead>{t("apiAccessScopes")}</TableHead>
                  <TableHead>{t("apiAccessCreatedAt")}</TableHead>
                  <TableHead>{t("apiAccessExpires")}</TableHead>
                  <TableHead>{t("apiAccessStatus")}</TableHead>
                  <TableHead>{t("apiAccessLastUsed")}</TableHead>
                  {canMutate ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => {
                  const active = isCredentialActive(credential);
                  return (
                    <TableRow key={credential.id}>
                      <TableCell className="font-medium">{credential.name}</TableCell>
                      <TableCell>
                        <code className="text-xs">{credential.keyPrefix}…</code>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {credential.scopes?.length ? (
                            credential.scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t("apiAccessInheritsGrants")}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(credential.createdAt, t("apiAccessNever"), locale)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(credential.expiresAt, t("apiAccessNeverExpires"), locale)}
                      </TableCell>
                      <TableCell>
                        <Badge tone={active ? "accent" : "neutral"}>
                          {active
                            ? t("apiAccessActive")
                            : credential.revokedAt
                              ? t("apiAccessRevoked")
                              : t("apiAccessExpired")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(credential.lastUsedAt, t("apiAccessNever"), locale)}
                      </TableCell>
                      {canMutate ? (
                        <TableCell className="text-right">
                          {active ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={mutating}
                              onClick={() => onRevokeCredential(credential)}
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
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PrincipalDialog({
  mode,
  detail,
  pending,
  onClose,
  onSubmit
}: {
  mode: "create" | "edit" | undefined;
  detail?: ServicePrincipalDetail;
  pending: boolean;
  onClose(): void;
  onSubmit(input: CreateServicePrincipalRequest | UpdateServicePrincipalRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  const principal = detail?.principal;
  return (
    <Dialog
      open={Boolean(mode)}
      title={mode === "edit" ? t("apiAccessEditPrincipal") : t("apiAccessCreatePrincipal")}
      onClose={onClose}
    >
      {mode ? (
        <PrincipalForm
          key={`${mode}:${principal?.id ?? "new"}`}
          principal={principal}
          pending={pending}
          onCancel={onClose}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function PrincipalForm({
  principal,
  pending,
  onCancel,
  onSubmit
}: {
  principal?: ServicePrincipalDetail["principal"];
  pending: boolean;
  onCancel(): void;
  onSubmit(input: CreateServicePrincipalRequest | UpdateServicePrincipalRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(principal?.displayLabel ?? "");
  const [description, setDescription] = useState(principal?.description ?? "");
  const [status, setStatus] = useState<"active" | "disabled">(principal?.status ?? "active");
  const [permissions, setPermissions] = useState<ServicePrincipalPermission[]>(
    principal?.permissions ?? DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const common = { displayLabel: name.trim(), status, permissions };
        void onSubmit(
          principal
            ? { ...common, description: optionalTrimmedValue(description) ?? null }
            : { ...common, description: optionalTrimmedValue(description) }
        );
      }}
    >
      <Field label={t("apiAccessName")}>
        <Input required value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t("apiAccessDescriptionLabel")}>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label={t("apiAccessStatus")}>
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value as "active" | "disabled")}
        >
          <option value="active">{t("apiAccessActive")}</option>
          <option value="disabled">{t("apiAccessDisabled")}</option>
        </Select>
      </Field>
      <GrantFields permissions={permissions} onChange={setPermissions} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? t("saving") : t("apiAccessSave")}
        </Button>
      </div>
    </form>
  );
}

function GrantFields({
  permissions,
  onChange
}: {
  permissions: ServicePrincipalPermission[];
  onChange(value: ServicePrincipalPermission[]): void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{t("apiAccessGrants")}</legend>
      {(["config_assets.read", "config_assets.release"] as const).map((permission) => (
        <label key={permission} className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={permissions.includes(permission)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...permissions, permission]
                  : permissions.filter((item) => item !== permission)
              )
            }
          />
          <span>
            <span className="block font-medium">
              {permission === "config_assets.read"
                ? t("apiAccessReadGrant")
                : t("apiAccessReleaseGrant")}
            </span>
            <span className="text-xs text-muted-foreground">
              {permission === "config_assets.read"
                ? t("apiAccessReadGrantDescription")
                : t("apiAccessReleaseGrantDescription")}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CredentialDialog({
  open,
  detail,
  pending,
  onClose,
  onSubmit
}: {
  open: boolean;
  detail?: ServicePrincipalDetail;
  pending: boolean;
  onClose(): void;
  onSubmit(input: CreateApiCredentialRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} title={t("apiAccessCreateCredential")} onClose={onClose}>
      {open && detail ? (
        <CredentialForm
          key={detail.principal.id}
          detail={detail}
          pending={pending}
          onCancel={onClose}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function CredentialForm({
  detail,
  pending,
  onCancel,
  onSubmit
}: {
  detail: ServicePrincipalDetail;
  pending: boolean;
  onCancel(): void;
  onSubmit(input: CreateApiCredentialRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  const allowedScopes = useMemo(
    () => scopesAllowedByPermissions(detail.principal.permissions),
    [detail.principal.permissions]
  );
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [scopes, setScopes] = useState<ApiCredentialScope[]>(allowedScopes);
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSubmit({
      name: name.trim(),
      scopes: constrainCredentialScopes(scopes, detail.principal.permissions),
      expiresAt: expiryInputToIso(expiry)
    });
  }
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Field label={t("apiAccessName")}>
        <Input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("apiAccessCredentialNamePlaceholder")}
        />
      </Field>
      <Field label={t("apiAccessExpiresAt")}>
        <Input
          type="datetime-local"
          value={expiry}
          min={localDateTimeMinimum()}
          onChange={(event) => setExpiry(event.target.value)}
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t("apiAccessScopes")}</legend>
        {allowedScopes.map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(event) =>
                setScopes(
                  event.target.checked
                    ? [...scopes, scope]
                    : scopes.filter((item) => item !== scope)
                )
              }
            />
            {scope}
          </label>
        ))}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={pending || !name.trim() || scopes.length === 0}>
          {pending ? t("saving") : t("apiAccessCreateCredential")}
        </Button>
      </div>
    </form>
  );
}

function SecretDialog({ secret, onClose }: { secret?: RevealedSecret; onClose(): void }) {
  const { t } = useTranslation();
  const [recorded, setRecorded] = useState<RecordedSecretCopy>();
  return (
    <Dialog open={Boolean(secret)} title={t("apiAccessCredentialReady")} onClose={onClose}>
      {secret ? (
        <SecretFields
          secret={secret}
          copyState={copyStateFor(recorded, secret.secret)}
          onCopy={(field, value) =>
            copySecretField(field, value, (state) => setRecorded({ secret: secret.secret, state }))
          }
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function formatDate(value: string | undefined, fallback: string, locale: LocaleCode): string {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value)
      )
    : fallback;
}

function localDateTimeMinimum(): string {
  const date = new Date(Date.now() + 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
