// @rights-screen: included in the rights wording guard.
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Pencil } from "lucide-react";
import {
  ApiError,
  completedOutput,
  type ApiClient,
  type ScopeAssignmentsOverview
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  ChipInput,
  Dialog,
  Field,
  FormNotice,
  IconButton,
  List,
  Picker,
  PickerButton,
  RadioGroup,
  Section,
  SkeletonList,
  Switch
} from "@work-shape/catalyst-ui";
import { useServicePrincipalsQuery } from "../../shared/api/workspace-queries";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import {
  isOwnHolder,
  knownGroups,
  rowOf,
  scopeRows,
  type ScopeAssignment,
  type ScopeHolder,
  type ScopeHolderKind,
  type ScopeRow,
  type ScopeValues
} from "./data-scope-model";

type Translate = TranslationContextValue["t"];

interface DataScopeApi {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

const ROW_COLUMNS = "@xl:grid-cols-[minmax(0,4fr)_minmax(0,9fr)_1.75rem]";

/**
 * Every holder's data scope assignments. Instance > Access shows the tab only while it loads
 * with a declared dimension; most instances declare none.
 */
export function useDataScopeOverview({ apiBaseUrl, authScope, client }: DataScopeApi) {
  return useQuery({
    queryKey: ["data-scope-overview", apiBaseUrl, authScope],
    queryFn: () => client.scope_assignments.overview(),
    retry: false
  });
}

/** Whether the instance declares a dimension to separate data by. */
export function declaresDataScope(overview: ScopeAssignmentsOverview | undefined): boolean {
  return Object.keys(overview?.dimensions ?? {}).length > 0;
}

/**
 * Instance > Access > Data access: per declared dimension, who sees which values and why, each
 * changed in a dialog.
 */
export function DataScopes({ api, userId }: { api: DataScopeApi; userId: string }) {
  const { t } = useTranslation();
  const query = useDataScopeOverview(api);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ dimension: string; holder?: ScopeHolder }>();
  const overview = query.data;
  const holdsPrincipalRows =
    overview?.assignments.some((row) => row.holderKind === "service_principal") ?? false;
  // The list of principals is read, and recorded as read, only where it names something.
  const principalsQuery = useServicePrincipalsQuery({
    ...api,
    enabled: holdsPrincipalRows || editing !== undefined
  });
  const principals = principalsQuery.error
    ? undefined
    : principalsQuery.data?.map(({ principal }) => ({
        id: principal.id,
        name: principal.displayLabel,
        active: principal.status === "active"
      }));
  const principalName = (id: string) =>
    principals?.find((principal) => principal.id === id)?.name ?? t("access.scopePrincipal");

  if (query.isError) {
    return (
      <Banner
        tone="danger"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              query.refetch().catch(() => undefined);
            }}
          >
            {t("tryAgain")}
          </Button>
        }
      >
        {t("access.scopesLoadFailed")}
      </Banner>
    );
  }
  if (overview === undefined) return <SkeletonList rows={4} />;
  const self = overview.people.find((person) => person.id === userId) ?? {
    id: userId,
    groups: []
  };
  return (
    <div className="grid">
      {Object.entries(overview.dimensions).map(([dimension, definition]) => {
        const rows = scopeRows(overview, dimension, principalName);
        const unassigned = rows.filter((row) => row.unassigned).length;
        return (
          <Section
            key={dimension}
            layout="stacked"
            title={definition.label}
            description={t("access.scopeIntro", { scope: definition.label })}
            state={
              unassigned > 0 ? (
                <Badge tone="warning" size="sm">
                  {unassigned === 1
                    ? t("access.scopeUnassignedOne")
                    : t("access.scopeUnassignedOther", { count: unassigned })}
                </Badge>
              ) : undefined
            }
            action={
              <Button size="sm" onClick={() => setEditing({ dimension })}>
                {t("access.scopeAssign")}
              </Button>
            }
          >
            <div className="@container">
              <div
                aria-hidden="true"
                className={`hidden gap-x-4 border-b px-3 pb-2 text-caption font-medium text-muted-foreground @xl:grid ${ROW_COLUMNS}`}
              >
                <span>{t("access.scopeWho")}</span>
                <span>{definition.label}</span>
              </div>
              <List className="gap-0">
                {rows.map((row) => (
                  <ScopeOverviewRow
                    key={`${row.holder.kind}:${row.holder.id}`}
                    row={row}
                    scope={definition.label}
                    own={isOwnHolder(row.holder, self)}
                    onEdit={() => setEditing({ dimension, holder: row.holder })}
                  />
                ))}
              </List>
            </div>
          </Section>
        );
      })}
      {editing ? (
        <ScopeDialog
          client={api.client}
          overview={overview}
          dimension={editing.dimension}
          holder={editing.holder}
          self={self}
          principals={principals}
          onSaved={() =>
            queryClient.invalidateQueries({
              queryKey: ["data-scope-overview", api.apiBaseUrl, api.authScope]
            })
          }
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function holderKindLabel(kind: ScopeHolderKind, t: Translate): string {
  return t(
    kind === "user"
      ? "access.scopePerson"
      : kind === "group"
        ? "access.scopeGroup"
        : "access.scopePrincipal"
  );
}

function valuesText(values: ScopeValues, t: Translate): string {
  return values === "all" ? t("access.scopeAll") : values.join(", ");
}

/** One holder: what they see, each part with where it comes from, and what is taken away. */
function ScopeOverviewRow({
  row,
  scope,
  own,
  onEdit
}: {
  row: ScopeRow;
  scope: string;
  own: boolean;
  onEdit(): void;
}) {
  const { t } = useTranslation();
  const { holder } = row;
  return (
    <li
      data-testid="scope-row"
      data-holder-kind={holder.kind}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 border-b px-3 py-3 last:border-0 ${ROW_COLUMNS}`}
    >
      <div className="grid min-w-0">
        <span className="truncate">{holder.name}</span>
        <span className="truncate text-caption text-muted-foreground">
          {holder.kind === "user" && row.groups.length > 0
            ? t("access.scopeMemberOf", { groups: row.groups.join(", ") })
            : holderKindLabel(holder.kind, t)}
        </span>
      </div>
      <div className="@xl:order-last">
        {own ? null : (
          <IconButton
            size="sm"
            label={t("access.scopeEdit", { name: holder.name, scope })}
            onClick={onEdit}
          >
            <Pencil aria-hidden="true" />
          </IconButton>
        )}
      </div>
      <ul className="col-span-2 grid min-w-0 gap-1 @xl:col-span-1">
        {row.unassigned ? (
          <li className="flex flex-wrap items-center gap-1.5">
            <Badge tone="warning" size="sm">
              {t("access.scopeNoneAssigned", { scope })}
            </Badge>
            <span className="text-caption text-muted-foreground">
              {t("access.scopeNoneAssignedHint", { scope })}
            </span>
          </li>
        ) : null}
        {row.sources.map((source) => (
          <li key={source.group ?? ""} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="min-w-0 break-words">{valuesText(source.values, t)}</span>
            <span className="text-caption text-muted-foreground">
              {source.group === undefined
                ? t("access.scopeDirect")
                : t("access.scopeThroughGroup", { group: source.group })}
            </span>
          </li>
        ))}
        {row.excluded === undefined ? null : (
          <li className="flex min-w-0 flex-wrap items-center gap-1.5">
            {/* An exclusion differs by its word and its badge, not by colour alone. */}
            <Badge tone="danger" appearance="outline" size="sm">
              <Ban aria-hidden="true" />
              {t("access.scopeExcluded")}
            </Badge>
            <span className="min-w-0 break-words">
              {row.excluded === "all"
                ? t("access.scopeExcludedAll", { scope })
                : row.excluded.join(", ")}
            </span>
          </li>
        )}
        {own ? (
          <li className="text-caption text-muted-foreground">{t("access.scopeOwnRow")}</li>
        ) : null}
      </ul>
    </li>
  );
}

/**
 * A holder's values on one dimension: chosen values or all, and for a person the values their
 * own revocation takes away, also those a group gives. Opened from a row the holder is set;
 * opened from "Assign" it is chosen by name.
 */
function ScopeDialog({
  client,
  overview,
  dimension,
  holder: given,
  self,
  principals,
  onSaved,
  onClose
}: {
  client: ApiClient;
  overview: ScopeAssignmentsOverview;
  dimension: string;
  holder?: ScopeHolder;
  self: { id: string; groups: readonly string[] };
  principals: readonly { id: string; name: string; active: boolean }[] | undefined;
  onSaved(): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const scope = overview.dimensions[dimension]?.label ?? dimension;
  const holders: ScopeHolder[] = [
    ...overview.people.map((person) => ({
      kind: "user" as const,
      id: person.id,
      name: person.displayLabel
    })),
    ...knownGroups(overview).map((group) => ({ kind: "group" as const, id: group, name: group })),
    ...(principals ?? [])
      .flatMap((principal) => (principal.active ? [principal] : []))
      .map((principal) => ({
        kind: "service_principal" as const,
        id: principal.id,
        name: principal.name
      }))
  ].filter((candidate) => !isOwnHolder(candidate, self));
  const [holder, setHolder] = useState(given);
  const [form, setForm] = useState(() => formOf(overview, dimension, given));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const formId = `scope-${dimension}`;
  const person = holder?.kind === "user";
  const inherited = person
    ? (overview.people.find((candidate) => candidate.id === holder.id)?.groups ?? []).flatMap(
        (group) => {
          const values = rowOf(
            overview.assignments,
            { kind: "group", id: group },
            dimension,
            "allow"
          );
          return values === undefined ? [] : [{ group, values }];
        }
      )
    : [];
  // An allowance of all with any revocation shows the person nothing: the resolver fails closed.
  const allWithExclusion =
    person &&
    !form.excludeAll &&
    form.excluded.length > 0 &&
    (form.all || inherited.some((source) => source.values === "all"));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!holder) return;
    setSaving(true);
    setFailure(undefined);
    const write = async (effect: ScopeAssignment["effect"], values: ScopeValues) =>
      completedOutput(
        await client.scope_assignments.set({
          body: { dimension, holderKind: holder.kind, holderId: holder.id, effect, values }
        })
      );
    const saved = formOf(overview, dimension, holder);
    const allow: ScopeValues = form.all ? "all" : form.values;
    const deny: ScopeValues = form.excludeAll ? "all" : form.excluded;
    (async () => {
      if (!sameValues(allow, saved.all ? "all" : saved.values)) await write("allow", allow);
      if (person && !sameValues(deny, saved.excludeAll ? "all" : saved.excluded))
        await write("deny", deny);
    })()
      .then(onSaved)
      .then(onClose)
      .catch((error: unknown) =>
        setFailure(
          error instanceof ApiError && error.status === 403
            ? t("access.scopeSaveRefused")
            : t("access.scopesSaveFailed")
        )
      )
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={
        given
          ? t("access.scopeDialogTitle", { scope, name: given.name })
          : t("access.scopeDialogNewTitle", { scope })
      }
      description={t("access.scopeDialogDescription", { scope })}
      footer={
        <>
          {failure !== undefined || (submitted && !holder) ? (
            <FormNotice tone="error" className="mr-auto">
              {failure ?? t("access.scopeChooseHolder")}
            </FormNotice>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t("access.scopeSave")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        {given ? null : (
          <Field label={t("access.scopeHolder")} required>
            <Picker
              search={holders.length > 7}
              options={(["user", "group", "service_principal"] as const).flatMap((kind) => {
                const options = holders
                  .filter((candidate) => candidate.kind === kind)
                  .map((candidate) => ({
                    value: `${candidate.kind}:${candidate.id}`,
                    label: candidate.name
                  }));
                return options.length === 0 ? [] : [{ heading: holderKindLabel(kind, t), options }];
              })}
              value={holder ? `${holder.kind}:${holder.id}` : undefined}
              onValueChange={(value) => {
                const next = holders.find(
                  (candidate) => `${candidate.kind}:${candidate.id}` === value
                );
                setHolder(next);
                setForm(formOf(overview, dimension, next));
              }}
            >
              <PickerButton
                label={t("access.scopeHolder")}
                placeholder={t("access.scopeChooseHolder")}
                value={holder?.name}
              />
            </Picker>
          </Field>
        )}
        {inherited.length > 0 ? (
          <div className="grid gap-1">
            <span className="text-label">{t("access.scopeInherited")}</span>
            <ul className="grid gap-1">
              {inherited.map((source) => (
                <li key={source.group} className="flex flex-wrap items-baseline gap-x-1.5">
                  <span>{valuesText(source.values, t)}</span>
                  <span className="text-caption text-muted-foreground">
                    {t("access.scopeThroughGroup", { group: source.group })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <RadioGroup
          label={t("access.scopeGiven", { scope })}
          options={[
            {
              value: "some",
              label: t("access.scopeChoiceSome"),
              description: t("access.scopeChoiceSomeDescription")
            },
            {
              value: "all",
              label: t("access.scopeChoiceAll"),
              description: t("access.scopeChoiceAllDescription")
            }
          ]}
          value={form.all ? "all" : "some"}
          onValueChange={(value) => setForm((current) => ({ ...current, all: value === "all" }))}
          disabled={!holder}
        />
        {form.all ? null : (
          <Field label={t("access.scopeValues", { scope })} hint={t("access.scopeValuesHint")}>
            <ChipInput
              value={form.values}
              onChange={(values) => setForm((current) => ({ ...current, values: [...values] }))}
              disabled={!holder}
            />
          </Field>
        )}
        {person ? (
          <>
            <Field
              label={t("access.scopeExcludeAll", { scope })}
              hint={t("access.scopeExcludeAllHint")}
              layout="inline"
            >
              <Switch
                checked={form.excludeAll}
                onCheckedChange={(excludeAll) => setForm((current) => ({ ...current, excludeAll }))}
              />
            </Field>
            {form.excludeAll ? null : (
              <Field
                label={t("access.scopeExcludedValues")}
                hint={t("access.scopeExcludedValuesHint")}
                optional
              >
                <ChipInput
                  value={form.excluded}
                  onChange={(excluded) =>
                    setForm((current) => ({ ...current, excluded: [...excluded] }))
                  }
                />
              </Field>
            )}
            {allWithExclusion ? (
              <Banner tone="warning">{t("access.scopeAllWithExclusion")}</Banner>
            ) : null}
          </>
        ) : null}
      </form>
    </Dialog>
  );
}

interface ScopeForm {
  all: boolean;
  values: string[];
  excludeAll: boolean;
  excluded: string[];
}

function formOf(
  overview: ScopeAssignmentsOverview,
  dimension: string,
  holder: ScopeHolder | undefined
): ScopeForm {
  const allow = holder ? rowOf(overview.assignments, holder, dimension, "allow") : undefined;
  const deny = holder ? rowOf(overview.assignments, holder, dimension, "deny") : undefined;
  return {
    all: allow === "all",
    values: allow === undefined || allow === "all" ? [] : [...allow],
    excludeAll: deny === "all",
    excluded: deny === undefined || deny === "all" ? [] : [...deny]
  };
}

function sameValues(left: ScopeValues, right: ScopeValues): boolean {
  if (left === "all" || right === "all") return left === right;
  return left.length === right.length && left.every((value) => right.includes(value));
}
