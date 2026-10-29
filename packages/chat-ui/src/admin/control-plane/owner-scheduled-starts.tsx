import { useMemo, useState } from "react";
import { CalendarClock, Trash2, UserRoundCog } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, listAll, type AdministeredUser } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  FormNotice,
  LoadError,
  Select,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { createScheduledStartsSource } from "../../chat/scheduled/scheduled-source";
import { scheduleLine, type WithheldScheduledStart } from "../../chat/scheduled/scheduled-model";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { personName } from "../../shared/person-name";
import { useSettingsPage } from "../../shared/settings-page-context";

/** How many of a person's starts one read asks for; the card reads them to the end. */
const PAGE_SIZE = 50;

/**
 * Users > a deactivated person: the scheduled prompts they own. They are paused and run as
 * nobody; an instance admin hands each to another person, who gets it paused, or deletes it.
 * The admin never reads their wording: a row names its agent, schedule and workspace. One in the
 * person's Personal Workspace can only be deleted. The server decides who may take one: an active
 * member of its workspace who may use its agent.
 */
export function OwnerScheduledStartsCard({
  owner,
  people
}: {
  owner: AdministeredUser;
  /** The accounts of the instance, to choose the new owner from. */
  people: readonly AdministeredUser[];
}) {
  const { t, locale } = useTranslation();
  const { apiBaseUrl, client } = useSettingsPage();
  const source = useMemo(() => createScheduledStartsSource(client), [client]);
  const queryClient = useQueryClient();
  const key = ["scheduled-starts", apiBaseUrl, "owned", owner.id] as const;
  const starts = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      listAll((paging) =>
        source.listOwnedBy(
          owner.id,
          { ...paging, limit: Math.min(paging.limit, PAGE_SIZE) },
          signal
        )
      )
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["scheduled-starts", apiBaseUrl] });
  const handover = useMutation({
    mutationFn: (input: { start: WithheldScheduledStart; ownerUserId: string }) =>
      source.handover(input.start.id, input.ownerUserId),
    onSuccess: refresh
  });
  const remove = useMutation({
    mutationFn: (start: WithheldScheduledStart) => source.remove(start.id),
    onSuccess: refresh
  });
  const [handing, setHanding] = useState<WithheldScheduledStart>();
  const [newOwner, setNewOwner] = useState("");
  const [deleting, setDeleting] = useState<WithheldScheduledStart>();
  const [done, setDone] = useState<string>();
  const candidates = people.filter(
    (person) => person.id !== owner.id && person.status === "active"
  );
  const rows = starts.data;

  return (
    <Card data-testid="owner-scheduled-starts">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock size={17} aria-hidden="true" />
          {t("scheduled.handover.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">{t("scheduled.handover.description")}</p>
        {starts.isError ? (
          <LoadError onRetry={() => void starts.refetch().catch(() => undefined)}>
            {t("scheduled.handover.listFailed")}
          </LoadError>
        ) : rows === undefined ? (
          <SkeletonList rows={2} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("scheduled.handover.none")}</p>
        ) : (
          <ul aria-label={t("scheduled.handover.title")} className="grid gap-2">
            {rows.map((start) => {
              const schedule = scheduleLine(start, { t, locale });
              return (
                <li
                  key={start.id}
                  className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 text-sm"
                >
                  <div className="grid min-w-0 flex-1 gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <strong className="truncate font-medium">{start.agentName}</strong>
                      <Badge tone="neutral">{t("scheduled.paused")}</Badge>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {`${schedule} · ${t(
                        start.workspaceKind === "personal"
                          ? "scheduled.handover.personal"
                          : "scheduled.handover.shared"
                      )}`}
                    </span>
                  </div>
                  <span className="flex shrink-0 items-center gap-2">
                    {start.workspaceKind === "shared" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          handover.reset();
                          setDone(undefined);
                          setNewOwner("");
                          setHanding(start);
                        }}
                      >
                        <UserRoundCog size={15} aria-hidden="true" />
                        {t("scheduled.handover.action")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t("scheduled.handover.deleteLabel", {
                        agent: start.agentName,
                        schedule
                      })}
                      onClick={() => {
                        remove.reset();
                        setDone(undefined);
                        setDeleting(start);
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {done ? <FormNotice tone="success">{done}</FormNotice> : null}
      </CardContent>
      <ConfirmDialog
        open={handing !== undefined}
        tone="primary"
        title={t("scheduled.handover.dialogTitle")}
        confirmLabel={t("scheduled.handover.action")}
        confirmDisabled={newOwner === ""}
        loading={handover.isPending}
        onConfirm={() => {
          if (!handing || newOwner === "") return;
          const name = personName(
            candidates.find((person) => person.id === newOwner)?.displayLabel,
            t
          );
          handover.mutate(
            { start: handing, ownerUserId: newOwner },
            {
              onSuccess: () => {
                setHanding(undefined);
                setDone(t("scheduled.handover.done", { name }));
              }
            }
          );
        }}
        onClose={() => setHanding(undefined)}
      >
        <div className="grid gap-3">
          <p>{t("scheduled.handover.dialogBody")}</p>
          <Field label={t("scheduled.handover.newOwner")}>
            <Select value={newOwner} onChange={(event) => setNewOwner(event.target.value)}>
              <option value="">{t("scheduled.handover.choose")}</option>
              {candidates.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.email
                    ? `${personName(person.displayLabel, t)} (${person.email})`
                    : personName(person.displayLabel, t)}
                </option>
              ))}
            </Select>
          </Field>
          {handover.isError ? (
            <FormNotice tone="error">{t(handoverRefusal(handover.error))}</FormNotice>
          ) : null}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== undefined}
        title={t("scheduled.deleteTitle")}
        confirmLabel={t("scheduled.delete")}
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting, {
            onSuccess: () => {
              setDeleting(undefined);
              setDone(t("scheduled.handover.deleted"));
            }
          });
        }}
        onClose={() => setDeleting(undefined)}
      >
        <div className="grid gap-3">
          <p>{t("scheduled.handover.deleteBody")}</p>
          {remove.isError ? (
            <FormNotice tone="error">{t("scheduled.deleteFailed")}</FormNotice>
          ) : null}
        </div>
      </ConfirmDialog>
    </Card>
  );
}

/** Why a handover was refused, in the admin's words: the server names who may not take it. */
function handoverRefusal(error: unknown): TranslationKey {
  if (error instanceof ApiError && error.status === 403) return "scheduled.handover.noRights";
  if (error instanceof ApiError && error.status === 404) return "scheduled.handover.notMember";
  if (error instanceof ApiError && error.status === 409) return "scheduled.handover.personalOnly";
  return "scheduled.handover.failed";
}
