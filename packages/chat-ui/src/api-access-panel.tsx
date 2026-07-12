import {
  Check,
  Clipboard,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ApiCredential,
  ApiCredentialScope,
  CreateApiCredentialRequest,
  CreateApiCredentialResponse,
  CreateServicePrincipalRequest,
  ServicePrincipalDetail,
  ServicePrincipalPermission,
  UpdateServicePrincipalRequest
} from "@vivd-catalyst/api-client";
import {
  constrainCredentialScopes,
  DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS,
  expiryInputToIso,
  isCredentialActive,
  optionalTrimmedValue,
  scopesAllowedByPermissions
} from "./api-access-model";
import { ControlPlanePage } from "./control-plane/control-plane-page";
import { useTranslation } from "./i18n";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { Input, Textarea } from "./ui/input";
import { Select } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

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
    <ControlPlanePage
      title={t("apiAccessTitle")}
      description={t("apiAccessDescription")}
      actions={
        canMutate ? <Button size="sm" onClick={() => setPrincipalDialog("create")}>
          <Plus aria-hidden="true" />
          {t("apiAccessCreatePrincipal")}
        </Button> : undefined
      }
    >
      {error || actionError ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError ?? error}
        </p>
      ) : null}

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(17rem,0.72fr)_minmax(28rem,1.28fr)]">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">{t("apiAccessServicePrincipals")}</CardTitle>
            <p className="text-xs text-muted-foreground">{t("apiAccessServicePrincipalsDescription")}</p>
          </CardHeader>
          <CardContent className="p-2 pt-1">
            {loading ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">{t("apiAccessLoading")}</p>
            ) : principals.length === 0 ? (
              <div className="grid justify-items-center gap-2 px-4 py-8 text-center">
                <ShieldCheck className="text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium">{t("apiAccessEmpty")}</p>
                <p className="max-w-sm text-xs text-muted-foreground">{t("apiAccessEmptyDescription")}</p>
              </div>
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
                          <span className="truncate text-sm font-medium">{detail.principal.displayLabel}</span>
                          <Badge variant={detail.principal.status === "active" ? "default" : "secondary"}>
                            {detail.principal.status === "active" ? t("apiAccessActive") : t("apiAccessDisabled")}
                          </Badge>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {detail.credentials.length} {detail.credentials.length === 1 ? t("apiAccessCredential") : t("apiAccessCredentials")}
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

      {principalDialog && canMutate ? <PrincipalDialog
        mode={principalDialog}
        detail={principalDialog === "edit" ? selectedPrincipal : undefined}
        pending={mutating}
        onClose={() => setPrincipalDialog(undefined)}
        onSubmit={async (input) => {
          setActionError(undefined);
          try {
            const detail = principalDialog === "edit" && selectedPrincipal
              ? await onUpdatePrincipal(selectedPrincipal.principal.id, input)
              : await onCreatePrincipal(input as CreateServicePrincipalRequest);
            setSelectedPrincipalId(detail.principal.id);
            setPrincipalDialog(undefined);
          } catch (caught) {
            setActionError(errorMessage(caught));
          }
        }}
      /> : null}

      {credentialDialogOpen && canMutate ? <CredentialDialog
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
            setActionError(errorMessage(caught));
          }
        }}
      /> : null}

      {canMutate && revealedCredential ? <SecretDialog
        secret={revealedCredential}
        onClose={onClearRevealedCredential}
      /> : null}

      {credentialToRevoke && canMutate ? <Dialog
        open={Boolean(credentialToRevoke)}
        title={t("apiAccessRevokeCredential")}
        onClose={() => setCredentialToRevoke(undefined)}
      >
        <p className="text-sm text-muted-foreground">{t("apiAccessRevokeDescription")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCredentialToRevoke(undefined)}>{t("cancel")}</Button>
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
                setActionError(errorMessage(caught));
              }
            }}
          >
            {t("apiAccessRevoke")}
          </Button>
        </div>
      </Dialog> : null}
    </ControlPlanePage>
  );
}

function PrincipalDetail({ detail, mutating, canMutate, onEdit, onCreateCredential, onRevokeCredential }: {
  detail: ServicePrincipalDetail;
  mutating: boolean;
  canMutate: boolean;
  onEdit(): void;
  onCreateCredential(): void;
  onRevokeCredential(credential: ApiCredential): void;
}) {
  const { t } = useTranslation();
  const { principal, credentials } = detail;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 p-4 pb-3">
        <div className="grid gap-1">
          <CardTitle className="text-base">{principal.displayLabel}</CardTitle>
          <p className="text-xs text-muted-foreground">{principal.description ?? t("apiAccessNoDescription")}</p>
        </div>
        {canMutate ? <Button variant="outline" size="sm" onClick={onEdit}><Pencil aria-hidden="true" />{t("apiAccessEdit")}</Button> : null}
      </CardHeader>
      <CardContent className="grid gap-5 p-4 pt-0">
        <div className="flex flex-wrap gap-2">
          {principal.permissions.map((permission) => <Badge key={permission} variant="secondary">{permission}</Badge>)}
          {principal.permissions.length === 0 ? <span className="text-xs text-muted-foreground">{t("apiAccessNoGrants")}</span> : null}
        </div>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{t("apiAccessApiKeys")}</h3>
              <p className="text-xs text-muted-foreground">{t("apiAccessApiKeysDescription")}</p>
            </div>
            {canMutate ? <Button size="sm" disabled={mutating || principal.status !== "active" || principal.permissions.length === 0} onClick={onCreateCredential}>
              <KeyRound aria-hidden="true" />{t("apiAccessCreateCredential")}
            </Button> : null}
          </div>
          {credentials.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t("apiAccessNoCredentials")}</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t("apiAccessName")}</TableHead><TableHead>{t("apiAccessKeyPrefix")}</TableHead>
                <TableHead>{t("apiAccessScopes")}</TableHead><TableHead>{t("apiAccessCreatedAt")}</TableHead>
                <TableHead>{t("apiAccessExpires")}</TableHead><TableHead>{t("apiAccessStatus")}</TableHead>
                <TableHead>{t("apiAccessLastUsed")}</TableHead>{canMutate ? <TableHead /> : null}
              </TableRow></TableHeader>
              <TableBody>{credentials.map((credential) => {
                const active = isCredentialActive(credential);
                return <TableRow key={credential.id}>
                  <TableCell className="font-medium">{credential.name}</TableCell>
                  <TableCell><code className="text-xs">{credential.keyPrefix}…</code></TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{credential.scopes?.length ? credential.scopes.map((scope) => <Badge key={scope} variant="secondary">{scope}</Badge>) : <span className="text-xs text-muted-foreground">{t("apiAccessInheritsGrants")}</span>}</div></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(credential.createdAt, t("apiAccessNever"))}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(credential.expiresAt, t("apiAccessNeverExpires"))}</TableCell>
                  <TableCell><Badge variant={active ? "default" : "secondary"}>{active ? t("apiAccessActive") : credential.revokedAt ? t("apiAccessRevoked") : t("apiAccessExpired")}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(credential.lastUsedAt, t("apiAccessNever"))}</TableCell>
                  {canMutate ? <TableCell className="text-right">{active ? <Button variant="ghost" size="sm" disabled={mutating} onClick={() => onRevokeCredential(credential)}>{t("apiAccessRevoke")}</Button> : null}</TableCell> : null}
                </TableRow>;
              })}</TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PrincipalDialog({ mode, detail, pending, onClose, onSubmit }: {
  mode: "create" | "edit" | undefined;
  detail?: ServicePrincipalDetail;
  pending: boolean;
  onClose(): void;
  onSubmit(input: CreateServicePrincipalRequest | UpdateServicePrincipalRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  const principal = detail?.principal;
  return <Dialog open={Boolean(mode)} title={mode === "edit" ? t("apiAccessEditPrincipal") : t("apiAccessCreatePrincipal")} onClose={onClose}>
    {mode ? <PrincipalForm key={`${mode}:${principal?.id ?? "new"}`} principal={principal} pending={pending} onCancel={onClose} onSubmit={onSubmit} /> : null}
  </Dialog>;
}

function PrincipalForm({ principal, pending, onCancel, onSubmit }: {
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
  return <form className="grid gap-4" onSubmit={(event) => {
    event.preventDefault();
    const common = { displayLabel: name.trim(), status, permissions };
    void onSubmit(principal ? { ...common, description: optionalTrimmedValue(description) ?? null } : { ...common, description: optionalTrimmedValue(description) });
  }}>
    <Field label={t("apiAccessName")}><Input required value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label={t("apiAccessDescriptionLabel")}><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
    <Field label={t("apiAccessStatus")}><Select value={status} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}><option value="active">{t("apiAccessActive")}</option><option value="disabled">{t("apiAccessDisabled")}</option></Select></Field>
    <GrantFields permissions={permissions} onChange={setPermissions} />
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>{t("cancel")}</Button><Button type="submit" disabled={pending || !name.trim()}>{pending ? t("saving") : t("apiAccessSave")}</Button></div>
  </form>;
}

function GrantFields({ permissions, onChange }: { permissions: ServicePrincipalPermission[]; onChange(value: ServicePrincipalPermission[]): void }) {
  const { t } = useTranslation();
  return <fieldset className="grid gap-2"><legend className="text-sm font-medium">{t("apiAccessGrants")}</legend>
    {(["config_assets.read", "config_assets.release"] as const).map((permission) => <label key={permission} className="flex items-start gap-2 rounded-md border p-3 text-sm"><input type="checkbox" className="mt-0.5" checked={permissions.includes(permission)} onChange={(event) => onChange(event.target.checked ? [...permissions, permission] : permissions.filter((item) => item !== permission))} /><span><span className="block font-medium">{permission === "config_assets.read" ? t("apiAccessReadGrant") : t("apiAccessReleaseGrant")}</span><span className="text-xs text-muted-foreground">{permission === "config_assets.read" ? t("apiAccessReadGrantDescription") : t("apiAccessReleaseGrantDescription")}</span></span></label>)}
  </fieldset>;
}

function CredentialDialog({ open, detail, pending, onClose, onSubmit }: {
  open: boolean;
  detail?: ServicePrincipalDetail;
  pending: boolean;
  onClose(): void;
  onSubmit(input: CreateApiCredentialRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  return <Dialog open={open} title={t("apiAccessCreateCredential")} onClose={onClose}>
    {open && detail ? <CredentialForm key={detail.principal.id} detail={detail} pending={pending} onCancel={onClose} onSubmit={onSubmit} /> : null}
  </Dialog>;
}

function CredentialForm({ detail, pending, onCancel, onSubmit }: {
  detail: ServicePrincipalDetail;
  pending: boolean;
  onCancel(): void;
  onSubmit(input: CreateApiCredentialRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  const allowedScopes = useMemo(() => scopesAllowedByPermissions(detail.principal.permissions), [detail.principal.permissions]);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [scopes, setScopes] = useState<ApiCredentialScope[]>(allowedScopes);
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSubmit({ name: name.trim(), scopes: constrainCredentialScopes(scopes, detail.principal.permissions), expiresAt: expiryInputToIso(expiry) });
  }
  return <form className="grid gap-4" onSubmit={submit}>
    <Field label={t("apiAccessName")}><Input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t("apiAccessCredentialNamePlaceholder")} /></Field>
    <Field label={t("apiAccessExpiresAt")}><Input type="datetime-local" value={expiry} min={localDateTimeMinimum()} onChange={(event) => setExpiry(event.target.value)} /></Field>
    <fieldset className="grid gap-2"><legend className="text-sm font-medium">{t("apiAccessScopes")}</legend>{allowedScopes.map((scope) => <label key={scope} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((item) => item !== scope))} />{scope}</label>)}</fieldset>
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>{t("cancel")}</Button><Button type="submit" disabled={pending || !name.trim() || scopes.length === 0}>{pending ? t("saving") : t("apiAccessCreateCredential")}</Button></div>
  </form>;
}

function SecretDialog({ secret, onClose }: { secret?: { secret: string; serverUrl: string; credentialName: string }; onClose(): void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"server" | "key">();
  return <Dialog open={Boolean(secret)} title={t("apiAccessCredentialReady")} onClose={onClose}>
    {secret ? <div className="grid gap-4">
      <p className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t("apiAccessSecretOnce")}</p>
      <CopyField label={t("apiAccessServerUrl")} value={secret.serverUrl} copied={copied === "server"} onCopy={() => { void copyText(secret.serverUrl).then(() => setCopied("server")); }} />
      <CopyField label={t("apiAccessApiKey")} value={secret.secret} copied={copied === "key"} secret onCopy={() => { void copyText(secret.secret).then(() => setCopied("key")); }} />
      <div className="flex justify-end"><Button onClick={onClose}>{t("apiAccessDone")}</Button></div>
    </div> : null}
  </Dialog>;
}

function CopyField({ label, value, copied, secret, onCopy }: { label: string; value: string; copied: boolean; secret?: boolean; onCopy(): void }) {
  return <div className="grid gap-1.5"><span className="text-sm font-medium">{label}</span><div className="flex min-w-0 gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 text-xs" data-secret={secret ? "one-time" : undefined}>{value}</code><Button type="button" variant="outline" size="icon" aria-label={`Copy ${label}`} onClick={onCopy}>{copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}</Button></div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}

function formatDate(value: string | undefined, fallback: string): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : fallback;
}

function localDateTimeMinimum(): string {
  const date = new Date(Date.now() + 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
