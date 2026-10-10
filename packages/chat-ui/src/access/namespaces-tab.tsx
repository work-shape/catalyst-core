import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  ConfigAssetSummary,
  CreateNamespaceRequest,
  NamespaceWithUsage,
  UpdateNamespaceRequest
} from "@vivd-catalyst/api-client";
import { NAMESPACE_PREFIX_MAX_LENGTH, NAMESPACE_PREFIX_MIN_LENGTH } from "@vivd-catalyst/core";
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FormNotice,
  IconButton,
  Input,
  Picker,
  SkeletonList,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type PickerOption
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  accessWriteFailure,
  agentsUnderPrefix,
  namespaceFormFrom,
  namespaceLockedLists,
  namespacePrefixProblem,
  namespaceRequest,
  overlappedPrefix,
  type NamespaceForm,
  type NamespacePrefixProblem
} from "./access-model";

/** From this many entries on, a tool or model picker shows its search field. */
const LIST_SEARCH_FROM_COUNT = 8;

/** What the instance offers a Namespace to list, and the assets a prefix would cover. */
interface NamespaceReferences {
  toolNames: readonly string[];
  modelBindings: readonly { id: string; model: string }[];
  assets: readonly ConfigAssetSummary[];
}

export interface NamespacesTabProps {
  /** Absent while the Namespaces load. */
  namespaces: readonly NamespaceWithUsage[] | undefined;
  loadFailed: boolean;
  onRetry(): void;
  /** Absent while the tools, models and assets load, and when they could not be loaded. */
  references: NamespaceReferences | undefined;
  referencesFailed: boolean;
  /** Each write rejects with the server's refusal, which the tab turns into its sentence. */
  onCreate(request: CreateNamespaceRequest): Promise<unknown>;
  onUpdate(prefix: string, request: UpdateNamespaceRequest): Promise<unknown>;
  onDelete(prefix: string): Promise<unknown>;
}

type OpenDialog = { kind: "create" } | { kind: "edit"; namespace: NamespaceWithUsage };

/** The Namespaces of the instance: what each one covers and limits, and the dialog that writes one. */
export function NamespacesTab({
  namespaces,
  loadFailed,
  onRetry,
  references,
  referencesFailed,
  onCreate,
  onUpdate,
  onDelete
}: NamespacesTabProps) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<OpenDialog | undefined>();
  const [pendingDelete, setPendingDelete] = useState<NamespaceWithUsage | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const newNamespace = (
    <Button size="sm" onClick={() => setDialog({ kind: "create" })}>
      {t("access.newNamespace")}
    </Button>
  );

  return (
    <div className="grid gap-4">
      {deleteFailed ? (
        <Banner tone="danger" onDismiss={() => setDeleteFailed(false)}>
          {t("access.namespaceDeleteFailed")}
        </Banner>
      ) : null}
      {loadFailed ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("access.namespacesLoadFailed")}
        </Banner>
      ) : namespaces === undefined ? (
        <SkeletonList rows={3} />
      ) : namespaces.length === 0 ? (
        <EmptyState action={newNamespace}>{t("access.namespacesEmpty")}</EmptyState>
      ) : (
        <>
          <div className="flex justify-end">{newNamespace}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("access.namespacePrefix")}</TableHead>
                <TableHead>{t("access.namespaceDisplayName")}</TableHead>
                <TableHead>{t("access.namespaceTools")}</TableHead>
                <TableHead>{t("access.namespaceModels")}</TableHead>
                <TableHead className="text-right">{t("access.namespaceAssets")}</TableHead>
                <TableHead className="text-right">{t("access.namespaceGrants")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("access.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {namespaces.map((namespace) => (
                <TableRow key={namespace.prefix} data-testid="namespace-row">
                  <TableCell className="font-mono">{namespace.prefix}</TableCell>
                  <TableCell>{namespace.displayName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {listSummary(namespace.allowedToolNames, t)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {listSummary(namespace.allowedModelBindingIds, t)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{namespace.assetCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{namespace.grantCount}</TableCell>
                  <TableCell className="w-0 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          size="sm"
                          label={t("access.namespaceMenu", { prefix: namespace.prefix })}
                        >
                          <Ellipsis aria-hidden="true" />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          icon={<Pencil aria-hidden="true" />}
                          onSelect={() => setDialog({ kind: "edit", namespace })}
                        >
                          {t("access.editNamespace")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          tone="danger"
                          icon={<Trash2 aria-hidden="true" />}
                          disabledReason={
                            namespace.grantCount === 0
                              ? undefined
                              : t(
                                  namespace.grantCount === 1
                                    ? "access.namespaceInUseOne"
                                    : "access.namespaceInUseOther",
                                  { count: namespace.grantCount }
                                )
                          }
                          onSelect={() => setPendingDelete(namespace)}
                        >
                          {t("access.deleteNamespace")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {dialog ? (
        <NamespaceDialog
          // A dialog opened for another Namespace starts from that Namespace's values.
          key={dialog.kind === "edit" ? dialog.namespace.prefix : "create"}
          namespace={dialog.kind === "edit" ? dialog.namespace : undefined}
          registeredPrefixes={(namespaces ?? []).map((namespace) => namespace.prefix)}
          references={references}
          referencesFailed={referencesFailed}
          onSave={(form) =>
            dialog.kind === "edit"
              ? onUpdate(dialog.namespace.prefix, updateRequest(form))
              : onCreate(namespaceRequest(form))
          }
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          open
          title={t("access.namespaceDeleteTitle", { prefix: pendingDelete.prefix })}
          confirmLabel={t("access.deleteNamespace")}
          loading={deleting}
          onConfirm={() => {
            setDeleting(true);
            setDeleteFailed(false);
            onDelete(pendingDelete.prefix)
              .catch(() => setDeleteFailed(true))
              .finally(() => {
                setDeleting(false);
                setPendingDelete(undefined);
              });
          }}
          onClose={() => setPendingDelete(undefined)}
        >
          {t("access.namespaceDeleteDescription")}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The prefix is the address of the record and stays out of a change. */
function updateRequest(form: NamespaceForm): UpdateNamespaceRequest {
  const { prefix: _prefix, ...request } = namespaceRequest(form);
  return request;
}

/** What a list of a Namespace comes to: no limit, nothing allowed, or how many entries. */
function listSummary(
  list: readonly string[] | null,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (list === null) {
    return t("access.namespaceNoLimit");
  }
  return list.length === 0
    ? t("access.namespaceNoneAllowed")
    : t("access.namespaceListed", { count: list.length });
}

function NamespaceDialog({
  namespace,
  registeredPrefixes,
  references,
  referencesFailed,
  onSave,
  onClose
}: {
  /** The Namespace that is changed; absent for a new one. */
  namespace: NamespaceWithUsage | undefined;
  registeredPrefixes: readonly string[];
  references: NamespaceReferences | undefined;
  referencesFailed: boolean;
  onSave(form: NamespaceForm): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [form, setForm] = useState(() => namespaceFormFrom(namespace));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | undefined>();
  const [refusedOverlap, setRefusedOverlap] = useState<
    { typed: string; registered: string } | undefined
  >();
  const editing = namespace !== undefined;
  const change = (patch: Partial<NamespaceForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  const typedProblem = editing
    ? undefined
    : namespacePrefixProblem(form.prefix, registeredPrefixes);
  const prefixProblem: NamespacePrefixProblem | undefined =
    typedProblem ??
    (refusedOverlap?.typed === form.prefix
      ? { kind: "overlap", prefix: refusedOverlap.registered }
      : undefined);
  // A prefix is judged from its first character on; an empty field waits for the submit.
  const showPrefixProblem = prefixProblem !== undefined && (form.prefix !== "" || submitted);
  const displayNameMissing = form.displayName.trim() === "";
  const agentCount = agentsUnderPrefix(references?.assets ?? [], form.prefix).length;
  const lockedLists = prefixProblem ? [] : namespaceLockedLists(form, agentCount);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(undefined);
    if (prefixProblem || displayNameMissing) {
      return;
    }
    setSaving(true);
    onSave(form)
      .then(onClose)
      .catch((error: unknown) => {
        const registered = overlappedPrefix(error);
        if (registered !== undefined) {
          setRefusedOverlap({ typed: form.prefix, registered });
          return;
        }
        setFailure(
          accessWriteFailure(error) === "unknownListEntry"
            ? "access.namespaceListEntryGone"
            : "access.namespaceSaveFailed"
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={
        editing
          ? t("access.namespaceEditTitle", { prefix: namespace.prefix })
          : t("access.namespaceCreateTitle")
      }
      description={t("access.namespaceDialogDescription")}
      footer={
        <>
          {failure ? (
            <FormNotice tone="error" className="mr-auto">
              {t(failure)}
            </FormNotice>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t(editing ? "access.saveNamespace" : "access.createNamespace")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        <Field
          label={t("access.namespacePrefix")}
          required={!editing}
          hint={t(editing ? "access.namespacePrefixFixed" : "access.namespacePrefixHint")}
          error={showPrefixProblem ? prefixProblemText(prefixProblem, t) : undefined}
        >
          <Input
            className="font-mono"
            value={form.prefix}
            disabled={editing}
            autoComplete="off"
            spellCheck={false}
            maxLength={NAMESPACE_PREFIX_MAX_LENGTH}
            onChange={(event) => change({ prefix: event.currentTarget.value })}
          />
        </Field>
        <Field
          label={t("access.namespaceDisplayName")}
          required
          error={
            submitted && displayNameMissing ? t("access.namespaceDisplayNameRequired") : undefined
          }
        >
          <Input
            value={form.displayName}
            autoComplete="off"
            onChange={(event) => change({ displayName: event.currentTarget.value })}
          />
        </Field>
        {referencesFailed ? (
          <Banner tone="danger">{t("access.referencesLoadFailed")}</Banner>
        ) : null}
        <LimitedList
          label={t("access.limitTools")}
          offHint={t("access.limitToolsHint")}
          emptyHint={t("access.toolsEmptyHint")}
          chooseLabel={t("access.chooseTools")}
          limited={form.limitTools}
          chosen={form.toolNames}
          options={(references?.toolNames ?? []).map((name) => ({ value: name, label: name }))}
          optionsReady={references !== undefined}
          onLimitedChange={(limitTools) => change({ limitTools })}
          onChosenChange={(toolNames) => change({ toolNames })}
        />
        <LimitedList
          label={t("access.limitModels")}
          offHint={t("access.limitModelsHint")}
          emptyHint={t("access.modelsEmptyHint")}
          listedHint={t("access.modelsListedHint")}
          chooseLabel={t("access.chooseModels")}
          limited={form.limitModels}
          chosen={form.modelBindingIds}
          options={(references?.modelBindings ?? []).map((binding) => ({
            value: binding.id,
            label: binding.id,
            description: binding.model === binding.id ? undefined : binding.model
          }))}
          optionsReady={references !== undefined}
          onLimitedChange={(limitModels) => change({ limitModels })}
          onChosenChange={(modelBindingIds) => change({ modelBindingIds })}
        />
        {lockedLists.length > 0 ? (
          <Banner tone="warning" title={t("access.namespaceLockTitle")}>
            <div className="grid gap-1">
              {lockedLists.map((list) => (
                <p key={list}>{t(lockWarningKey(list, agentCount), { count: agentCount })}</p>
              ))}
            </div>
          </Banner>
        ) : null}
      </form>
    </Dialog>
  );
}

function lockWarningKey(list: "tools" | "models", agentCount: number): TranslationKey {
  if (list === "tools") {
    return agentCount === 1 ? "access.namespaceLockToolsOne" : "access.namespaceLockToolsOther";
  }
  return agentCount === 1 ? "access.namespaceLockModelsOne" : "access.namespaceLockModelsOther";
}

function prefixProblemText(
  problem: NamespacePrefixProblem,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (problem.kind) {
    case "length":
      return t("access.namespacePrefixLength", {
        min: NAMESPACE_PREFIX_MIN_LENGTH,
        max: NAMESPACE_PREFIX_MAX_LENGTH
      });
    case "pattern":
      return t("access.namespacePrefixPattern");
    case "overlap":
      return t("access.namespacePrefixOverlap", { prefix: problem.prefix });
  }
}

/**
 * One list a Namespace may limit: a switch, and while it is on the picker with what is chosen.
 * On with nothing chosen is a state of its own, and the hint says what it means.
 */
function LimitedList({
  label,
  offHint,
  emptyHint,
  listedHint,
  chooseLabel,
  limited,
  chosen,
  options,
  optionsReady,
  onLimitedChange,
  onChosenChange
}: {
  label: string;
  offHint: string;
  emptyHint: string;
  /** What a list with entries means, where that needs saying. */
  listedHint?: string;
  chooseLabel: string;
  limited: boolean;
  chosen: readonly string[];
  options: readonly PickerOption[];
  optionsReady: boolean;
  onLimitedChange(limited: boolean): void;
  onChosenChange(chosen: string[]): void;
}) {
  const { t } = useTranslation();
  // A chosen entry the instance no longer offers stays visible, so it can be removed.
  const shownOptions = [
    ...options,
    ...chosen
      .filter((value) => !options.some((option) => option.value === value))
      .map((value) => ({ value, label: value }))
  ];
  return (
    <div className="grid gap-2">
      <Field layout="inline" label={label} hint={limited ? undefined : offHint}>
        <Switch checked={limited} onCheckedChange={onLimitedChange} />
      </Field>
      {limited ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Picker
              multiple
              search={shownOptions.length >= LIST_SEARCH_FROM_COUNT}
              options={shownOptions}
              value={chosen}
              onValueChange={onChosenChange}
            >
              <Button variant="outline" size="sm" disabled={!optionsReady}>
                {chooseLabel}
              </Button>
            </Picker>
            <span className="text-caption text-muted-foreground">
              {t("access.chosenCount", { count: chosen.length, total: shownOptions.length })}
            </span>
          </div>
          {chosen.length === 0 ? (
            <Banner tone="warning" layout="line">
              {emptyHint}
            </Banner>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {chosen.map((value) => (
                  <Chip
                    key={value}
                    size="sm"
                    onRemove={() => onChosenChange(chosen.filter((other) => other !== value))}
                  >
                    {value}
                  </Chip>
                ))}
              </div>
              {listedHint === undefined ? null : (
                <p className="text-caption text-muted-foreground">{listedHint}</p>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
