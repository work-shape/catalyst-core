import { useState } from "react";
import {
  ApiError,
  POLICY_OPERATION_KINDS,
  type AlwaysAllowLock,
  type Policies,
  type PolicyOperation,
  type PolicyOperationKind,
  type PolicySetting,
  type SetPolicySettingRequest
} from "@work-shape/catalyst-api-client";
import {
  Button,
  EmptyState,
  Field,
  FilterBar,
  Input,
  List,
  ListRow,
  LoadError,
  PageHeader,
  Section,
  Select,
  SkeletonList,
  Switch
} from "@work-shape/catalyst-ui";
import {
  usePoliciesQuery,
  useSetAlwaysAllowLockMutation,
  useSetPolicySettingMutation
} from "../../../shared/api/policies";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";

type PolicyValue = Policies["defaults"]["changing"];
type Translate = ReturnType<typeof useTranslation>["t"];

const VALUES: readonly PolicyValue[] = ["allow", "confirm", "approval", "deny"];
const READING_VALUES: readonly PolicyValue[] = ["allow", "deny"];
/** The choice of an action's own row that removes its setting. */
const DEFAULT = "default";

/** Where a change on the page came from, so its answer shows beside it. */
type ChangeKey = string;
const settingKey = (
  setting: Pick<SetPolicySettingRequest, "operation" | "workspaceId" | "assetKind">
) => `setting:${setting.operation}:${setting.workspaceId ?? ""}:${setting.assetKind ?? ""}`;
const lockKey = (operation: string) => `lock:${operation}`;

/** Whether an entry, a name or a pattern such as `connection.crm.*`, names the operation. */
function names(entry: string, operation: string): boolean {
  return entry.endsWith(".*") ? operation.startsWith(entry.slice(0, -1)) : entry === operation;
}

/** A setting that applies to every call of its operations: not narrowed. */
const unnarrowed = (setting: PolicySetting) =>
  setting.workspaceId === undefined && setting.assetKind === undefined;

/** Why a change was refused, in the person's language. */
function refusalText(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    const reason = reasonOf(error.payload);
    const key = `policies.refused.${reason ?? ""}`;
    if (reason !== undefined && isRefusalKey(key)) return t(key);
  }
  return t("policies.saveFailed");
}

const REFUSAL_KEYS = [
  "policies.refused.policy_names_itself",
  "policies.refused.unknown_operation",
  "policies.refused.reading_operation_waits",
  "policies.refused.locked_by_release"
] as const satisfies readonly TranslationKey[];

function isRefusalKey(key: string): key is (typeof REFUSAL_KEYS)[number] {
  return (REFUSAL_KEYS as readonly string[]).includes(key);
}

function reasonOf(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  const details = payload.error.details;
  return isRecord(details) && typeof details.reason === "string" ? details.reason : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ChangeState {
  /** The change on its way. */
  pending?: ChangeKey;
  /** The change last saved. */
  saved?: ChangeKey;
  /** The change last refused, and why. */
  failure?: { key: ChangeKey; text: string };
}

/**
 * Settings > Instance > Policies (OP-2): the defaults of the instance, the admin's central
 * settings by action or pattern, the locks of "Always allow", and every action with what it
 * does in plain words. Every change goes through `policies.set` or
 * `policies.set_always_allow_lock`, which require `policy.manage` and record the change in the
 * audit log; it holds from the next call.
 */
export function PoliciesPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const policies = usePoliciesQuery({ apiBaseUrl, authScope, client });
  const heldMessage = t("policies.saveFailed");
  const setSetting = useSetPolicySettingMutation({ apiBaseUrl, authScope, client, heldMessage });
  const setLock = useSetAlwaysAllowLockMutation({ apiBaseUrl, authScope, client, heldMessage });
  const [saved, setSaved] = useState<ChangeKey | undefined>();
  const [failure, setFailure] = useState<ChangeState["failure"]>();

  const changeSetting = (change: SetPolicySettingRequest) => {
    const key = settingKey(change);
    setSaved(undefined);
    setFailure(undefined);
    setSetting.mutate(change, {
      onSuccess: () => setSaved(key),
      onError: (error) => setFailure({ key, text: refusalText(error, t) })
    });
  };
  const changeLock = (operation: string, locked: boolean) => {
    const key = lockKey(operation);
    setSaved(undefined);
    setFailure(undefined);
    setLock.mutate(
      { operation, locked },
      {
        onSuccess: () => setSaved(key),
        onError: (error) => setFailure({ key, text: refusalText(error, t) })
      }
    );
  };
  const pending = setSetting.isPending
    ? settingKey(setSetting.variables)
    : setLock.isPending
      ? lockKey(setLock.variables.operation)
      : undefined;
  const state: ChangeState = {
    ...(pending === undefined ? {} : { pending }),
    ...(saved === undefined ? {} : { saved }),
    ...(failure === undefined ? {} : { failure })
  };

  const header = (
    <PageHeader title={t("settings.policies")} description={t("policies.description")} />
  );
  if (policies.isError) {
    return (
      <>
        {header}
        <LoadError
          onRetry={() => {
            policies.refetch().catch(() => undefined);
          }}
        >
          {t("policies.loadFailed")}
        </LoadError>
      </>
    );
  }
  if (!policies.data) {
    return (
      <>
        {header}
        <SkeletonList rows={4} />
      </>
    );
  }
  return (
    <>
      {header}
      <DefaultsSection policies={policies.data} />
      <SettingsSection policies={policies.data} state={state} onChange={changeSetting} />
      <LocksSection policies={policies.data} state={state} onChange={changeLock} />
      <ActionsSection
        policies={policies.data}
        state={state}
        onSetting={changeSetting}
        onLock={changeLock}
      />
    </>
  );
}

function DefaultsSection({ policies }: { policies: Policies }) {
  const { t } = useTranslation();
  return (
    <Section
      layout="stacked"
      title={t("policies.defaults")}
      description={t("policies.defaultsDescription")}
    >
      <List data-testid="policy-defaults">
        <ListRow
          title={t("policies.defaultReading")}
          description={t(`policies.valueSentence.${policies.defaults.reading}`)}
          descriptionWraps
        />
        <ListRow
          title={t("policies.defaultChanging")}
          description={t(`policies.valueSentence.${policies.defaults.changing}`)}
          descriptionWraps
        />
        <ListRow
          title={t("policies.alwaysAllowClasses")}
          description={t("policies.alwaysAllowClassesValue")}
          descriptionWraps
        />
      </List>
    </Section>
  );
}

/** One line under a change: on its way, saved, or refused with the reason. */
function ChangeNote({ id, state }: { id: ChangeKey; state: ChangeState }) {
  const { t } = useTranslation();
  if (state.failure?.key === id) {
    return (
      <span role="alert" className="block text-caption text-destructive">
        {state.failure.text}
      </span>
    );
  }
  if (state.saved === id && state.pending !== id) {
    return (
      <span role="status" className="block text-caption text-muted-foreground">
        {t("policies.saved")}
      </span>
    );
  }
  return null;
}

/** Where a setting applies, in words: its workspace and its kind. */
function scopeWords(setting: PolicySetting, t: Translate): string {
  const workspace =
    setting.workspaceId === undefined
      ? t("policies.everyWorkspace")
      : t("policies.inWorkspace", {
          workspace: setting.workspaceName ?? t("policies.unknownWorkspace")
        });
  const kind =
    setting.assetKind === undefined
      ? t("policies.everyKind")
      : t("policies.forKind", { kind: setting.assetKind });
  return `${workspace} · ${kind}`;
}

function SettingsSection({
  policies,
  state,
  onChange
}: {
  policies: Policies;
  state: ChangeState;
  onChange(change: SetPolicySettingRequest): void;
}) {
  const { t } = useTranslation();
  return (
    <Section
      layout="stacked"
      title={t("policies.settings")}
      description={t("policies.settingsDescription")}
      count={policies.settings.length}
    >
      {policies.settings.length === 0 ? (
        <EmptyState layout="inline">{t("policies.settingsEmpty")}</EmptyState>
      ) : (
        <List data-testid="policy-settings">
          {policies.settings.map((setting) => {
            const key = settingKey(setting);
            return (
              <ListRow
                key={key}
                data-testid="policy-setting"
                data-operation={setting.operation}
                title={<span className="font-mono">{setting.operation}</span>}
                descriptionWraps
                description={
                  <>
                    <span className="block">
                      {t(`policies.value.${setting.value}`)} · {scopeWords(setting, t)}
                    </span>
                    <ChangeNote id={key} state={state} />
                  </>
                }
                actionsVisible
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={state.pending === key}
                    aria-label={t("policies.removeSetting", { operation: setting.operation })}
                    onClick={() =>
                      onChange({
                        operation: setting.operation,
                        ...(setting.workspaceId === undefined
                          ? {}
                          : { workspaceId: setting.workspaceId }),
                        ...(setting.assetKind === undefined
                          ? {}
                          : { assetKind: setting.assetKind }),
                        value: null
                      })
                    }
                  >
                    {t("policies.remove")}
                  </Button>
                }
              />
            );
          })}
        </List>
      )}
      <AddSetting policies={policies} state={state} onChange={onChange} />
    </Section>
  );
}

/** The form that adds a setting by name or pattern, narrowed where the admin chooses. */
function AddSetting({
  policies,
  state,
  onChange
}: {
  policies: Policies;
  state: ChangeState;
  onChange(change: SetPolicySettingRequest): void;
}) {
  const { t } = useTranslation();
  const [operation, setOperation] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [assetKind, setAssetKind] = useState("");
  const [value, setValue] = useState<PolicyValue>("approval");
  const change: SetPolicySettingRequest = {
    operation: operation.trim(),
    ...(workspaceId === "" ? {} : { workspaceId }),
    ...(assetKind === "" ? {} : { assetKind }),
    value
  };
  const key = settingKey(change);
  return (
    <form
      className="grid gap-3"
      data-testid="policy-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (change.operation !== "") onChange(change);
      }}
    >
      <p className="text-label">{t("policies.add")}</p>
      <Field label={t("policies.operationField")} hint={t("policies.operationHint")}>
        <Input
          value={operation}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono"
          onChange={(event) => setOperation(event.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("policies.workspaceField")}>
          <Select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">{t("policies.everyWorkspace")}</option>
            {policies.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("policies.kindField")}>
          <Select value={assetKind} onChange={(event) => setAssetKind(event.target.value)}>
            <option value="">{t("policies.everyKind")}</option>
            {policies.assetKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("policies.valueField")}>
          <Select
            value={value}
            onChange={(event) => {
              const next = VALUES.find((candidate) => candidate === event.target.value);
              if (next) setValue(next);
            }}
          >
            {VALUES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`policies.value.${candidate}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={change.operation === "" || state.pending === key}
        >
          {t("policies.addAction")}
        </Button>
        <ChangeNote id={key} state={state} />
      </div>
    </form>
  );
}

function LocksSection({
  policies,
  state,
  onChange
}: {
  policies: Policies;
  state: ChangeState;
  onChange(operation: string, locked: boolean): void;
}) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState("");
  const typed = pattern.trim();
  return (
    <Section
      layout="stacked"
      title={t("policies.locks")}
      description={t("policies.locksDescription")}
      count={policies.locks.length}
    >
      {policies.locks.length === 0 ? (
        <EmptyState layout="inline">{t("policies.locksEmpty")}</EmptyState>
      ) : (
        <List data-testid="policy-locks">
          {policies.locks.map((lock) => (
            <LockRow
              key={`${lock.source}:${lock.operation}`}
              lock={lock}
              state={state}
              onChange={onChange}
            />
          ))}
        </List>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed !== "") onChange(typed, true);
        }}
      >
        <Field className="min-w-0 flex-1" label={t("policies.operationField")}>
          <Input
            value={pattern}
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono"
            onChange={(event) => setPattern(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={typed === "" || state.pending === lockKey(typed)}
        >
          {t("policies.lockPattern")}
        </Button>
        <ChangeNote id={lockKey(typed)} state={state} />
      </form>
    </Section>
  );
}

function LockRow({
  lock,
  state,
  onChange
}: {
  lock: AlwaysAllowLock;
  state: ChangeState;
  onChange(operation: string, locked: boolean): void;
}) {
  const { t } = useTranslation();
  const key = lockKey(lock.operation);
  return (
    <ListRow
      data-testid="policy-lock"
      data-operation={lock.operation}
      data-source={lock.source}
      title={<span className="font-mono">{lock.operation}</span>}
      descriptionWraps
      description={
        <>
          <span className="block">{t(`policies.lockSource.${lock.source}`)}</span>
          {lock.source === "instance" ? <ChangeNote id={key} state={state} /> : null}
        </>
      }
      actionsVisible
      actions={
        lock.source === "instance" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={state.pending === key}
            aria-label={t("policies.unlockLabel", { operation: lock.operation })}
            onClick={() => onChange(lock.operation, false)}
          >
            {t("policies.unlock")}
          </Button>
        ) : undefined
      }
    />
  );
}

function ActionsSection({
  policies,
  state,
  onSetting,
  onLock
}: {
  policies: Policies;
  state: ChangeState;
  onSetting(change: SetPolicySettingRequest): void;
  onLock(operation: string, locked: boolean): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<PolicyOperationKind | "">("");
  const query = search.trim().toLowerCase();
  const shown = policies.operations.filter(
    (operation) =>
      (kind === "" || operation.kind === kind) &&
      (query === "" ||
        operation.operation.toLowerCase().includes(query) ||
        (operation.title?.toLowerCase().includes(query) ?? false))
  );
  return (
    <Section
      layout="stacked"
      title={t("policies.actions")}
      description={t("policies.actionsDescription")}
      count={policies.operations.length}
    >
      <FilterBar
        search={
          <Input
            type="search"
            aria-label={t("policies.search")}
            placeholder={t("policies.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        filters={
          <Select
            aria-label={t("policies.kindFilter")}
            className="w-full sm:w-56"
            value={kind}
            onChange={(event) => {
              const next = POLICY_OPERATION_KINDS.find((value) => value === event.target.value);
              setKind(next ?? "");
            }}
          >
            <option value="">{t("policies.allKinds")}</option>
            {POLICY_OPERATION_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`policies.kind.${value}`)}
              </option>
            ))}
          </Select>
        }
        count={String(shown.length)}
      />
      {policies.truncated.map((entry) => (
        <p key={entry.prefix} className="text-caption text-muted-foreground">
          {t("policies.truncated", { prefix: entry.prefix, limit: entry.limit })}
        </p>
      ))}
      {shown.length === 0 ? (
        <EmptyState layout="inline">{t("policies.noMatch")}</EmptyState>
      ) : (
        POLICY_OPERATION_KINDS.map((group) => {
          const rows = shown.filter((operation) => operation.kind === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="grid gap-1">
              <h3 className="text-label text-muted-foreground">{t(`policies.kind.${group}`)}</h3>
              <List data-testid="policy-operations" data-kind={group}>
                {rows.map((operation) => (
                  <OperationRow
                    key={operation.operation}
                    operation={operation}
                    policies={policies}
                    state={state}
                    onSetting={onSetting}
                    onLock={onLock}
                  />
                ))}
              </List>
            </div>
          );
        })
      )}
    </Section>
  );
}

/** What an action does, in words: reads or changes, how far, and its value. */
function summary(operation: PolicyOperation, t: Translate): string {
  return [
    t(`policies.effect.${operation.effect}`),
    ...(operation.effect === "changing"
      ? [t(`policies.class.${operation.changeClass ?? "irreversible"}`)]
      : []),
    t(`policies.value.${operation.value}`)
  ].join(" · ");
}

function OperationRow({
  operation,
  policies,
  state,
  onSetting,
  onLock
}: {
  operation: PolicyOperation;
  policies: Policies;
  state: ChangeState;
  onSetting(change: SetPolicySettingRequest): void;
  onLock(operation: string, locked: boolean): void;
}) {
  const { t } = useTranslation();
  const name = operation.operation;
  const own = policies.settings.find(
    (setting) => setting.operation === name && unnarrowed(setting)
  );
  const pattern =
    own === undefined && operation.source === "central_setting"
      ? policies.settings.find(
          (setting) =>
            unnarrowed(setting) &&
            setting.operation.endsWith(".*") &&
            names(setting.operation, name)
        )
      : undefined;
  const defaultValue = operation.declaredDefault ?? policies.defaults[operation.effect];
  const choices = operation.effect === "reading" ? READING_VALUES : VALUES;
  const key = settingKey({ operation: name });
  const sourceWords = pattern
    ? t("policies.setByPattern", { pattern: pattern.operation })
    : own === undefined && operation.source === "central_setting"
      ? t("policies.setByDeployment")
      : t(`policies.source.${operation.source}`);
  return (
    <ListRow
      data-testid="policy-operation"
      data-operation={name}
      data-value={operation.value}
      expandable
      title={operation.title ?? <span className="font-mono">{name}</span>}
      descriptionWraps
      description={summary(operation, t)}
    >
      <div className="grid gap-3 px-2 pt-1 pb-3">
        {operation.title ? (
          <p className="font-mono text-caption text-muted-foreground">{name}</p>
        ) : null}
        <p className="text-caption text-muted-foreground" data-testid="policy-operation-sentence">
          {t(`policies.valueSentence.${operation.value}`)} ({sourceWords})
        </p>
        <Field label={t("policies.valueOf", { operation: operation.title ?? name })}>
          <Select
            className="w-full sm:w-72"
            value={own?.value ?? DEFAULT}
            disabled={state.pending === key}
            onChange={(event) => {
              const next = choices.find((value) => value === event.target.value);
              onSetting({ operation: name, value: next ?? null });
            }}
          >
            <option value={DEFAULT}>
              {t("policies.default", { value: t(`policies.value.${defaultValue}`) })}
            </option>
            {choices.map((value) => (
              <option key={value} value={value}>
                {t(`policies.value.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <ChangeNote id={key} state={state} />
        {operation.effect === "changing" ? (
          <AlwaysAllowControl
            operation={operation}
            locks={policies.locks}
            alwaysAllowByClass={policies.alwaysAllowByClass}
            state={state}
            onLock={onLock}
          />
        ) : null}
      </div>
    </ListRow>
  );
}

/**
 * Whether people may always allow a change. A class that never permits it says so; a lock of
 * the release config or of a pattern is shown and cannot be lifted from the row.
 */
function AlwaysAllowControl({
  operation,
  locks,
  alwaysAllowByClass,
  state,
  onLock
}: {
  operation: PolicyOperation;
  locks: readonly AlwaysAllowLock[];
  alwaysAllowByClass: Policies["alwaysAllowByClass"];
  state: ChangeState;
  onLock(operation: string, locked: boolean): void;
}) {
  const { t } = useTranslation();
  const name = operation.operation;
  if (!alwaysAllowByClass[operation.changeClass ?? "irreversible"]) {
    return (
      <p className="text-caption text-muted-foreground">{t("policies.alwaysAllowNotForClass")}</p>
    );
  }
  const byRelease = operation.alwaysAllowLock === "release";
  const exact = locks.some((lock) => lock.source === "instance" && lock.operation === name);
  const byPattern =
    !byRelease && !exact
      ? locks.find((lock) => lock.source === "instance" && names(lock.operation, name))
      : undefined;
  const key = lockKey(name);
  const id = `always-allow-${name}`;
  return (
    <div
      className="grid gap-1"
      data-testid="policy-always-allow"
      data-locked={operation.alwaysAllowLock}
    >
      <div className="flex items-center gap-3">
        <Switch
          id={id}
          checked={operation.alwaysAllowLock === undefined}
          disabled={byRelease || byPattern !== undefined || state.pending === key}
          onCheckedChange={(checked) => onLock(name, !checked)}
        />
        <label htmlFor={id} className="text-body">
          {t("policies.alwaysAllow")}
        </label>
      </div>
      <p className="text-caption text-muted-foreground">
        {byRelease
          ? t("policies.lockedByRelease")
          : byPattern
            ? t("policies.lockedByPattern", { pattern: byPattern.operation })
            : t("policies.alwaysAllowHint")}
      </p>
      <ChangeNote id={key} state={state} />
    </div>
  );
}
