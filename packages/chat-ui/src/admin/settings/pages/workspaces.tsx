import { Pencil } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  UpdateWorkspaceBuildLimitsRequest,
  WorkspaceBuildLimits
} from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  FormNotice,
  IconButton,
  PageHeader,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { accessWriteFailure, loadFailure } from "../../access/access-model";
import { useAccessMutations, useWorkspaceLimitsQuery } from "../../access/access-queries";
import { LimitedList, listSummary } from "../../access/limited-list";
import { useConfigAssetsOverviewQuery } from "../../../shared/api/workspace-queries";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { modelDisplayLabel } from "../../../shared/model-label";
import { useSettingsPage } from "../../../shared/settings-page-context";

/** What the instance offers a workspace to list. */
interface LimitReferences {
  toolNames: readonly string[];
  modelBindings: readonly { id: string; model: string; label?: string }[];
}

/**
 * Instance > Workspaces: the build limits of each Shared Workspace, the tools and models the
 * agents it owns may use (WS-BUILD-1). Set by whoever manages users; a workspace owner cannot.
 */
export function WorkspacesPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const workspacesQuery = useWorkspaceLimitsQuery(api);
  // Tools and models come with the agent configuration, which has its own right.
  const overviewQuery = useConfigAssetsOverviewQuery({ ...api, enabled: true });
  const mutations = useAccessMutations(api);
  const [editing, setEditing] = useState<WorkspaceBuildLimits | undefined>();
  const workspaces = workspacesQuery.data;
  const overview = overviewQuery.data;
  const referencesFailure = loadFailure(overviewQuery.error);

  return (
    <>
      <PageHeader
        title={t("settings.workspaces")}
        description={t("access.workspacesDescription")}
      />
      {workspacesQuery.error ? (
        <Banner
          tone="danger"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                workspacesQuery.refetch().catch(() => undefined);
              }}
            >
              {t("tryAgain")}
            </Button>
          }
        >
          {t("access.workspacesLoadFailed")}
        </Banner>
      ) : workspaces === undefined ? (
        <SkeletonList rows={3} />
      ) : workspaces.length === 0 ? (
        <EmptyState>{t("access.workspacesEmpty")}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("access.workspaceName")}</TableHead>
              <TableHead>{t("access.listTools")}</TableHead>
              <TableHead>{t("access.listModels")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("access.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.map((workspace) => (
              <TableRow key={workspace.id} data-testid="workspace-limits-row">
                <TableCell>{workspace.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {listSummary(workspace.allowedToolNames, t)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {listSummary(workspace.allowedModelBindingIds, t)}
                </TableCell>
                <TableCell className="w-0 text-right">
                  <IconButton
                    size="sm"
                    label={t("access.editWorkspaceLimits", { name: workspace.name })}
                    onClick={() => setEditing(workspace)}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing ? (
        <WorkspaceLimitsDialog
          key={editing.id}
          workspace={editing}
          references={
            overview && {
              toolNames: overview.references.enabledToolNames,
              modelBindings: overview.references.modelBindings
            }
          }
          referencesFailure={referencesFailure}
          onSave={(body) =>
            mutations.updateWorkspaceLimits.mutateAsync({ workspaceId: editing.id, body })
          }
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </>
  );
}

function WorkspaceLimitsDialog({
  workspace,
  references,
  referencesFailure,
  onSave,
  onClose
}: {
  workspace: WorkspaceBuildLimits;
  /** Absent while the tools and models load, and when they could not be loaded. */
  references: LimitReferences | undefined;
  referencesFailure: ReturnType<typeof loadFailure>;
  onSave(body: UpdateWorkspaceBuildLimitsRequest): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [toolNames, setToolNames] = useState(workspace.allowedToolNames);
  const [modelBindingIds, setModelBindingIds] = useState(workspace.allowedModelBindingIds);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | undefined>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    setSaving(true);
    onSave({ allowedToolNames: toolNames, allowedModelBindingIds: modelBindingIds })
      .then(onClose)
      .catch((error: unknown) =>
        setFailure(
          accessWriteFailure(error) === "unknownListEntry"
            ? "access.listEntryGone"
            : "access.workspaceLimitsSaveFailed"
        )
      )
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("access.workspaceLimitsTitle", { name: workspace.name })}
      description={t("access.workspaceLimitsDescription")}
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
            {t("access.saveWorkspaceLimits")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        {referencesFailure ? (
          <Banner tone="danger">
            {t(
              referencesFailure === "forbidden"
                ? "access.referencesForbidden"
                : "access.referencesLoadFailed"
            )}
          </Banner>
        ) : null}
        <LimitedList
          label={t("access.limitTools")}
          offHint={t("access.workspaceLimitToolsHint")}
          emptyHint={t("access.workspaceToolsEmptyHint")}
          chooseLabel={t("access.chooseTools")}
          limited={toolNames !== null}
          chosen={toolNames ?? []}
          options={(references?.toolNames ?? []).map((name) => ({ value: name, label: name }))}
          optionsReady={references !== undefined}
          onLimitedChange={(limited) => setToolNames(limited ? [] : null)}
          onChosenChange={setToolNames}
        />
        <LimitedList
          label={t("access.limitModels")}
          offHint={t("access.limitModelsHint")}
          emptyHint={t("access.workspaceModelsEmptyHint")}
          listedHint={t("access.workspaceModelsListedHint")}
          chooseLabel={t("access.chooseModels")}
          limited={modelBindingIds !== null}
          chosen={modelBindingIds ?? []}
          options={(references?.modelBindings ?? []).map((binding) => ({
            value: binding.id,
            label: binding.id,
            description: binding.model === binding.id ? undefined : modelDisplayLabel(binding)
          }))}
          optionsReady={references !== undefined}
          onLimitedChange={(limited) => setModelBindingIds(limited ? [] : null)}
          onChosenChange={setModelBindingIds}
        />
      </form>
    </Dialog>
  );
}
