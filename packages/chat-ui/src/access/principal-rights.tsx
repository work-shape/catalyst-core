import { Box, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { AssetSummary } from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  List,
  ListRow,
  Picker,
  PickerButton,
  RadioGroup,
  RegistryIcon,
  Section,
  SkeletonList
} from "@vivd-catalyst/ui";
import {
  grantableResources,
  principalGrantFailure,
  type PrincipalGrantFailure,
  type PrincipalGrantKind,
  type PrincipalGrantView
} from "./principal-grants-model";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";
import { formatDate } from "../control-plane/locale-format";

type Translate = TranslationContextValue["t"];

/** From this many resources on, the picker shows its search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

/** The kind whose rights the empty section offers by name. */
const CONNECTION_KIND = "connection";

/** What a right allows, in a sentence. A right without one is named by its action. */
const ACTION_SENTENCES: Record<string, TranslationKey> = {
  "connection.use": "apiAccessRightsMayUseConnection"
};

const KIND_NAMES: Record<string, TranslationKey> = {
  connection: "connections.kindSingular"
};

const FAILURE_SENTENCES: Record<PrincipalGrantFailure, TranslationKey> = {
  notAdministrable: "apiAccessRightsNotAdministrable",
  actionNotGrantable: "apiAccessRightsActionNotGrantable",
  invalidScope: "apiAccessRightsInvalidScope",
  effectNotGrantable: "apiAccessRightsEffectNotGrantable",
  duplicate: "apiAccessRightsDuplicate",
  unknownHolder: "apiAccessRightsUnknownHolder",
  held: "apiAccessWaitsForApproval",
  other: "apiAccessRightsGiveFailed"
};

function actionSentence(action: string, t: Translate): string {
  const key = ACTION_SENTENCES[action];
  return key === undefined ? t("apiAccessRightsMay", { action }) : t(key);
}

function kindName(kind: string, t: Translate): string {
  const key = KIND_NAMES[kind];
  return key === undefined ? kind : t(key);
}

function KindIcon({ kind }: { kind: string | undefined }) {
  const className = "size-4 text-muted-foreground";
  return kind === CONNECTION_KIND ? (
    <RegistryIcon name="connection" className={className} />
  ) : (
    <Box aria-hidden="true" className={className} />
  );
}

/** The rights of one principal, as its page read them. */
type PrincipalRightsRead =
  | { status: "loading" }
  /** The reader is not shown the rights of service principals. */
  | { status: "forbidden" }
  | { status: "failed"; retry(): void }
  | { status: "ready"; rows: PrincipalGrantView[] };

export interface PrincipalRightsProps {
  principal: { id: string; displayLabel: string; status: "active" | "disabled" };
  /** The reader administers service principals: the section offers giving and removing. */
  canMutate: boolean;
  read: PrincipalRightsRead;
  /** The kinds a right can be given on, with the rights, as the instance names them. */
  kinds: readonly PrincipalGrantKind[];
  /** The resources the reader is shown, of those kinds. Absent while they load. */
  resources: { items: readonly AssetSummary[] | undefined; failed: boolean };
  workspaces: readonly { id: string; name: string }[];
  onGive(input: { action: string; assetId: string }): Promise<unknown>;
  onRemove(grantId: string): Promise<unknown>;
}

/**
 * The section of a service principal's page that says which resources it may use. Each row is
 * one right on one resource; the principal holds nothing on a resource that is not listed, so a
 * Workflow that runs as it calls the listed Connections and no other.
 */
export function PrincipalRights({
  principal,
  canMutate,
  read,
  kinds,
  resources,
  workspaces,
  onGive,
  onRemove
}: PrincipalRightsProps) {
  const { t, locale } = useTranslation();
  const [giving, setGiving] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<PrincipalGrantView>();
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const rows = read.status === "ready" ? read.rows : undefined;
  const offered = canMutate && kinds.length > 0;
  const offersConnection = kinds.some((kind) => kind.kind === CONNECTION_KIND);
  const resourceName = (row: PrincipalGrantView) => row.title ?? t("apiAccessRightsHiddenResource");

  return (
    <Section
      layout="stacked"
      headingLevel={3}
      className="border-t pt-5 pb-0"
      data-principal-rights=""
      title={t("apiAccessRightsTitle")}
      description={t("apiAccessRightsDescription")}
      count={rows?.length}
      action={
        offered && rows !== undefined && rows.length > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setGiving(true)}>
            <Plus aria-hidden="true" />
            {t("apiAccessRightsAdd")}
          </Button>
        ) : undefined
      }
    >
      {principal.status === "disabled" && rows !== undefined && rows.length > 0 ? (
        <Banner tone="warning" layout="line">
          {t("apiAccessRightsDisabledNote")}
        </Banner>
      ) : null}
      {removeFailed ? (
        <Banner tone="danger" onDismiss={() => setRemoveFailed(false)}>
          {t("apiAccessRightsRemoveFailed")}
        </Banner>
      ) : null}
      {read.status === "loading" ? (
        <SkeletonList rows={2} />
      ) : read.status === "forbidden" ? (
        <EmptyState layout="inline">{t("apiAccessRightsForbidden")}</EmptyState>
      ) : read.status === "failed" ? (
        <InlineError className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("apiAccessRightsLoadFailed")}</span>
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t("tryAgain")}
          </Button>
        </InlineError>
      ) : read.rows.length === 0 ? (
        <EmptyState
          layout="inline"
          icon={<RegistryIcon name="connection" />}
          action={
            offered ? (
              <Button size="sm" onClick={() => setGiving(true)}>
                <Plus aria-hidden="true" />
                {t(offersConnection ? "apiAccessRightsGiveConnection" : "apiAccessRightsGiveFirst")}
              </Button>
            ) : undefined
          }
        >
          {t(
            canMutate && kinds.length === 0
              ? "apiAccessRightsNoneGrantable"
              : canMutate
                ? "apiAccessRightsEmpty"
                : "apiAccessRightsEmptyReadOnly"
          )}
        </EmptyState>
      ) : (
        <List aria-label={t("apiAccessRightsTitle")}>
          {read.rows.map((row) => {
            const given = formatDate(row.grant.createdAt, locale);
            return (
              <ListRow
                key={row.grant.id}
                data-testid="principal-right"
                leading={<KindIcon kind={row.kind} />}
                title={resourceName(row)}
                chips={
                  <>
                    {row.place ? (
                      <Chip size="sm">
                        {row.place.kind === "instance"
                          ? t("apiAccessRightsInstance")
                          : row.place.name === undefined
                            ? t("apiAccessRightsWorkspaceUnnamed")
                            : t("apiAccessRightsWorkspace", { name: row.place.name })}
                      </Chip>
                    ) : null}
                    {row.gone ? (
                      <Badge tone="warning" size="sm">
                        {t("apiAccessRightsResourceGone")}
                      </Badge>
                    ) : null}
                  </>
                }
                description={
                  <>
                    {actionSentence(row.grant.action, t)}
                    {" · "}
                    {row.grantedBy === undefined
                      ? t("apiAccessRightsGivenOn", { date: given })
                      : t("apiAccessRightsGivenBy", { name: row.grantedBy, date: given })}
                    {row.gone ? ` · ${t("apiAccessRightsResourceGoneHint")}` : null}
                  </>
                }
                descriptionWraps
                actionsVisible
                actions={
                  canMutate ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("apiAccessRightsRemoveNamed", { resource: resourceName(row) })}
                      onClick={() => setPendingRemove(row)}
                    >
                      {t("apiAccessRightsRemove")}
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </List>
      )}
      {giving && offered ? (
        <GiveRightDialog
          principal={principal}
          kinds={kinds}
          resources={resources}
          workspaces={workspaces}
          held={rows?.map((row) => row.grant) ?? []}
          onGive={onGive}
          onClose={() => setGiving(false)}
        />
      ) : null}
      {pendingRemove ? (
        <ConfirmDialog
          open
          title={t("apiAccessRightsRemoveTitle")}
          confirmLabel={t("apiAccessRightsRemove")}
          loading={removing}
          onConfirm={() => {
            setRemoving(true);
            setRemoveFailed(false);
            onRemove(pendingRemove.grant.id)
              .catch(() => setRemoveFailed(true))
              .finally(() => {
                setRemoving(false);
                setPendingRemove(undefined);
              });
          }}
          onClose={() => setPendingRemove(undefined)}
        >
          {t("apiAccessRightsRemoveDescription", {
            principal: principal.displayLabel,
            resource: resourceName(pendingRemove)
          })}
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}

/**
 * Gives the principal one right on one resource. The kinds and the rights are the ones the
 * instance names; the resources are the ones the reader is shown, without those the principal
 * holds the right on already. A refusal says what the instance refused and what to do next.
 */
function GiveRightDialog({
  principal,
  kinds,
  resources,
  workspaces,
  held,
  onGive,
  onClose
}: Pick<PrincipalRightsProps, "principal" | "kinds" | "resources" | "workspaces" | "onGive"> & {
  held: readonly PrincipalGrantView["grant"][];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [kindId, setKindId] = useState(kinds[0]?.kind ?? "");
  const kind = kinds.find((candidate) => candidate.kind === kindId) ?? kinds[0];
  const [chosenAction, setChosenAction] = useState<string>();
  const action = kind?.actions.find((candidate) => candidate === chosenAction) ?? kind?.actions[0];
  const [assetId, setAssetId] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PrincipalGrantFailure>();

  const choices =
    kind === undefined || resources.items === undefined
      ? []
      : grantableResources(resources.items, { kind: kind.kind, action, held });
  const chosen = choices.find((candidate) => candidate.id === assetId);
  const ofConnection = kind?.kind === CONNECTION_KIND;
  const resourceLabel = ofConnection ? t("connections.kindSingular") : t("apiAccessRightsResource");
  const placeOf = ({ scope }: AssetSummary) =>
    scope.kind === "workspace"
      ? (workspaces.find(({ id }) => id === scope.workspaceId)?.name ??
        t("apiAccessRightsWorkspaceUnnamed"))
      : t("apiAccessRightsInstance");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(undefined);
    if (action === undefined || chosen === undefined) {
      return;
    }
    setSaving(true);
    onGive({ action, assetId: chosen.id })
      .then(onClose)
      .catch((error: unknown) => setFailure(principalGrantFailure(error)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("apiAccessRightsDialogTitle", { principal: principal.displayLabel })}
      description={t("apiAccessRightsDialogDescription")}
      footer={
        <>
          {submitted && chosen === undefined ? (
            <FormNotice tone="error" className="mr-auto">
              {t("apiAccessRightsIncomplete")}
            </FormNotice>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t("apiAccessRightsSubmit")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        {failure === undefined ? null : (
          <Banner tone="danger" data-right-refusal={failure}>
            {t(FAILURE_SENTENCES[failure])}
          </Banner>
        )}
        {kinds.length > 1 ? (
          <RadioGroup
            variant="plain"
            label={t("apiAccessRightsKind")}
            options={kinds.map((candidate) => ({
              value: candidate.kind,
              label: kindName(candidate.kind, t)
            }))}
            value={kind?.kind}
            // A resource belongs to its kind, and a kind has rights of its own.
            onValueChange={(next) => {
              setKindId(next);
              setChosenAction(undefined);
              setAssetId("");
            }}
          />
        ) : null}
        <Field
          label={resourceLabel}
          required
          error={resources.failed ? t("apiAccessRightsResourcesFailed") : undefined}
          hint={
            resources.items !== undefined && choices.length === 0
              ? t("apiAccessRightsNoResources")
              : undefined
          }
        >
          <Picker
            search={choices.length >= PICKER_SEARCH_FROM_COUNT}
            options={choices.map((candidate) => ({
              value: candidate.id,
              label: candidate.title.trim() || candidate.name,
              description: `${candidate.name} · ${placeOf(candidate)}`
            }))}
            value={assetId}
            onValueChange={setAssetId}
          >
            <PickerButton
              label={resourceLabel}
              placeholder={t(
                ofConnection ? "apiAccessRightsChooseConnection" : "apiAccessRightsChooseResource"
              )}
              value={chosen ? chosen.title.trim() || chosen.name : undefined}
              disabled={resources.items === undefined || choices.length === 0}
            />
          </Picker>
        </Field>
        <RadioGroup
          label={t("apiAccessRightsRight")}
          options={(kind?.actions ?? []).map((candidate) => ({
            value: candidate,
            label: actionSentence(candidate, t),
            description:
              candidate === "connection.use" ? t("apiAccessRightsUseConnectionHint") : undefined
          }))}
          value={action}
          onValueChange={(next) => {
            setChosenAction(next);
            // The resources left to choose depend on the right.
            setAssetId("");
          }}
        />
      </form>
    </Dialog>
  );
}
