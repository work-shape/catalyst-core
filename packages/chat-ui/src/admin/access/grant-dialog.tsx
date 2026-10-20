// @rights-screen: included in the rights wording guard.
import { useId, useState, type FormEvent } from "react";
import type {
  AdministeredUser,
  ConfigAssetSummary,
  CreatePermissionGrantRequest
} from "@work-shape/catalyst-api-client";
import {
  Button,
  Checkbox,
  Dialog,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  FormNotice,
  Picker,
  PickerButton,
  RadioGroup,
  RegistryIcon,
  useDocsLinkShown
} from "@work-shape/catalyst-ui";
import { DocsReference } from "../../shared/docs-links";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import { refusalAskingInstanceAdmin } from "../settings/ask-instance-admin";
import {
  accessWriteFailure,
  emptyGrantForm,
  grantAction,
  grantableUsers,
  grantExtras,
  grantFormVerbs,
  grantLevels,
  grantRequests,
  GrantWriteError,
  isConfigAssetGrantKind,
  levelVerbs,
  withGrantKind,
  type AccessWriteFailure,
  type GrantForm,
  type GrantKind,
  type GrantVerb,
  type GrantWriteResult,
  type LoadFailure
} from "./access-model";
import { grantKinds, rightAllowNoteKeys, rightSentenceKeys, scopeChoice } from "./grant-words";
import { grantOptions, type GrantChoices } from "./grant-options";
import { actionLabel, rightVerb, verbKeys, verbLabel } from "./right-words";

/** From this many entries on, a picker of the grant dialog shows its search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

type Translate = TranslationContextValue["t"];

const failureKeys: Partial<Record<AccessWriteFailure, TranslationKey>> = {
  userBeingDeleted: "access.grantUserBeingDeleted",
  unknownHolder: "access.grantUnknownHolder",
  assetGone: "access.grantAssetGone",
  rightNotOffered: "access.grantRightNotOffered",
  moduleOff: "access.grantModuleOff",
  missingManageRight: "access.grantMissingManageRight",
  holderIsSuperadmin: "access.grantHolderIsSuperadmin"
};

/**
 * The sentence for a grant that stopped at one row, with how many rows were written before. A
 * giver who lacks the right is told whom to ask.
 */
function grantFailureText(error: unknown, t: Translate, instanceAdminName?: string): string {
  const cause = error instanceof GrantWriteError ? error.cause : error;
  const failure = accessWriteFailure(cause);
  const refusal = t(failureKeys[failure] ?? "access.grantFailed");
  const sentence =
    failure === "missingManageRight"
      ? refusalAskingInstanceAdmin(refusal, t, instanceAdminName)
      : refusal;
  return error instanceof GrantWriteError && error.written > 0
    ? `${sentence} ${t("access.grantPartlyWritten", { written: error.written, total: error.total })}`
    : sentence;
}

export interface GrantDialogProps {
  /** The users the caller is shown. Absent while they load and when they could not be loaded. */
  users: readonly AdministeredUser[] | undefined;
  usersFailed: boolean;
  /** The active agents and skills. Absent while they load and when they could not be loaded. */
  assets: readonly ConfigAssetSummary[] | undefined;
  /** `forbidden` when the caller may not read the agents and skills of the instance. */
  assetsFailure: LoadFailure | undefined;
  /** The assets of every kind the dialog offers, by kind. */
  kindAssets: Partial<Record<GrantKind, GrantChoices>>;
  /** What the giver may give, where. */
  options: ReturnType<typeof grantOptions>;
  /** The Shared Workspaces, for a grant on what a workspace owns. */
  workspaces?: GrantChoices;
  /** An active instance admin, whom a refusal names as the one who can help. */
  instanceAdminName?: string;
  /** Writes the rows; see `GrantsTabProps.onGrant`. */
  onGrant(requests: readonly CreatePermissionGrantRequest[]): Promise<GrantWriteResult>;
  onClose(): void;
}

/**
 * The New right dialog: a person, a level of one kind and a place, each picked by name. Further
 * rights that are no level are ticked one by one; a deny waits behind its own control.
 */
export function GrantDialog({
  users,
  usersFailed,
  assets,
  assetsFailure,
  kindAssets,
  options,
  workspaces,
  instanceAdminName,
  onGrant,
  onClose
}: GrantDialogProps) {
  const { t, locale } = useTranslation();
  const docsLinkShown = useDocsLinkShown();
  const formId = useId();
  const [form, setForm] = useState<GrantForm>(emptyGrantForm);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const change = (patch: Partial<GrantForm>) => setForm((current) => ({ ...current, ...patch }));

  const holders = grantableUsers(users ?? []);
  const holder = holders.find((user) => user.id === form.holderId);
  const kinds = options.kinds;
  const kind = kinds.includes(form.kind) ? form.kind : (kinds[0] ?? form.kind);
  const requestedVerbs = grantFormVerbs({ ...form, kind }).filter(
    (verb) => options.places(kind, [verb]).length > 0
  );
  const scopeKinds = options.places(kind, requestedVerbs);
  const scopeKind = scopeKinds.find((scope) => scope === form.scopeKind) ?? scopeKinds[0];
  const allowedWorkspaces = options.choices(kind, "workspace", requestedVerbs);
  const words = grantKinds[kind].words;
  // What the asset picker chooses from: the agents or skills, or the assets of a further kind.
  const choices: GrantChoices =
    kindAssets?.[kind] ??
    (isConfigAssetGrantKind(kind)
      ? {
          items: assets?.flatMap((candidate) =>
            candidate.kind === kind && candidate.id !== undefined
              ? [{ id: candidate.id, name: candidate.name }]
              : []
          ),
          failed: assetsFailure !== undefined
        }
      : { items: undefined, failed: false });
  const kindItems = options.choices(kind, "asset", requestedVerbs);
  const assetsError = !choices.failed
    ? undefined
    : isConfigAssetGrantKind(kind) && assetsFailure === "forbidden"
      ? refusalAskingInstanceAdmin(t("access.referencesForbidden"), t, instanceAdminName)
      : t(words.assetsLoadFailed);
  const asset = kindItems.find((candidate) => candidate.id === form.assetId);
  const kindIcon = <RegistryIcon name={kind} className="size-4 text-muted-foreground" />;
  /** The sentence under a right, with what else the right needs where an allow alone does nothing. */
  const rightSentence = (verb: GrantVerb): string[] => {
    const action = grantAction(kind, verb);
    const sentence = action && rightSentenceKeys[action];
    const note = action && form.effect === "allow" ? rightAllowNoteKeys[action] : undefined;
    return [sentence, note].flatMap((key) => (key === undefined ? [] : [t(key)]));
  };
  const rightDescription = (verb: GrantVerb): string | undefined =>
    rightSentence(verb).join(" ") || undefined;
  /** Under a level: what it allows, and which other levels it brings or refuses with it. */
  const levelDescription = (level: GrantVerb): string | undefined => {
    const others = levelVerbs(kind, level, form.effect).flatMap((verb) => {
      const tableVerb = verb === level ? undefined : rightVerb(grantAction(kind, verb) ?? "");
      return tableVerb ? [t(verbKeys[tableVerb])] : [];
    });
    const list = new Intl.ListFormat(locale, { type: "conjunction" }).format(others);
    const brings =
      others.length === 0
        ? []
        : [
            t(form.effect === "allow" ? "access.levelIncludes" : "access.levelRefusesAbove", {
              verbs: list
            })
          ];
    return [...rightSentence(level), ...brings].join(" ") || undefined;
  };
  /** A right's words: its verb, or the action's own words where it is no verb of the table. */
  const rightLabel = (verb: GrantVerb): string => {
    const action = grantAction(kind, verb) ?? `${kind}.${verb}`;
    const tableVerb = rightVerb(action);
    return tableVerb ? verbLabel(tableVerb, t) : actionLabel(action, t);
  };
  const workspace = allowedWorkspaces.find((candidate) => candidate.id === form.workspaceId);
  // With one place to choose there is nothing to ask: the step is left out.
  const verbs = options.verbs(
    kind,
    scopeKind,
    scopeKind === "workspace" ? workspace?.id : asset?.id
  );
  // A level is offered where every verb it stands for can be given there.
  const levels = grantLevels(kind).filter((level) =>
    levelVerbs(kind, level, form.effect).every((verb) => verbs.includes(verb))
  );
  const level = levels.find((candidate) => candidate === form.level);
  const extras = grantExtras(kind).filter((verb) => verbs.includes(verb));
  const selectedExtras = form.extras.filter((verb) => extras.includes(verb));
  const requests = grantRequests({
    ...form,
    kind,
    level,
    extras: selectedExtras,
    scopeKind,
    assetId: asset?.id,
    workspaceId: workspace?.id
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(undefined);
    if (!requests) {
      return;
    }
    setSaving(true);
    onGrant(requests)
      .then(onClose)
      .catch((error: unknown) => setFailure(grantFailureText(error, t, instanceAdminName)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("access.grantDialogTitle")}
      description={t("access.grantDialogDescription")}
      footer={
        <>
          {failure !== undefined || (submitted && !requests) ? (
            <FormNotice tone="error" className="mr-auto">
              {failure ?? t("access.grantIncomplete")}
            </FormNotice>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t("access.submitGrant")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        <Field
          label={t("access.grantHolder")}
          required
          error={usersFailed ? t("access.usersLoadFailed") : undefined}
        >
          <Picker
            search={holders.length >= PICKER_SEARCH_FROM_COUNT}
            options={holders.map((user) => ({
              value: user.id,
              label: user.displayLabel,
              description: user.email
            }))}
            value={form.holderId}
            onValueChange={(holderId) => change({ holderId })}
          >
            <PickerButton
              label={t("access.grantHolder")}
              placeholder={t("access.choosePerson")}
              value={holder?.displayLabel}
              disabled={users === undefined}
            />
          </Picker>
        </Field>
        <RadioGroup
          variant="plain"
          label={t("access.grantKind")}
          options={kinds.map((kind) => ({
            value: kind,
            label: t(grantKinds[kind].label)
          }))}
          value={kind}
          // An asset belongs to its kind, and a kind has its own actions and places.
          onValueChange={(kind) => setForm((current) => withGrantKind(current, kind))}
        />
        {levels.length > 0 ? (
          <RadioGroup<string>
            label={t("access.grantLevel")}
            options={levels.map((candidate) => {
              const description = levelDescription(candidate);
              return {
                value: candidate,
                label: rightLabel(candidate),
                ...(description === undefined ? {} : { description })
              };
            })}
            value={level ?? ""}
            onValueChange={(level) => change({ level: levels.find((other) => other === level) })}
          />
        ) : null}
        {extras.length > 0 ? (
          <fieldset className="grid gap-2.5">
            <legend className="mb-2.5 text-label">{t("access.grantExtras")}</legend>
            {extras.map((verb) => (
              <Checkbox
                key={verb}
                label={rightLabel(verb)}
                description={rightDescription(verb)}
                checked={selectedExtras.includes(verb)}
                onCheckedChange={(checked) =>
                  change({
                    extras: checked
                      ? [...selectedExtras, verb]
                      : selectedExtras.filter((other) => other !== verb)
                  })
                }
              />
            ))}
          </fieldset>
        ) : null}
        {scopeKinds.length > 1 ? (
          <RadioGroup
            label={t("access.grantScopeKind")}
            options={scopeKinds.map((scopeKind) => {
              const keys = scopeChoice(scopeKind, kind);
              return { value: scopeKind, label: t(keys.label), description: t(keys.description) };
            })}
            value={scopeKind}
            onValueChange={(scopeKind) => change({ scopeKind })}
            hint={docsLinkShown ? <DocsReference to="rightPlace" /> : undefined}
          />
        ) : null}
        {scopeKind === "workspace" ? (
          <Field
            label={t("access.grantWorkspace")}
            required
            error={workspaces?.failed ? t("access.workspacesLoadFailed") : undefined}
            hint={allowedWorkspaces.length === 0 ? t("access.noWorkspaces") : undefined}
          >
            <Picker
              search={allowedWorkspaces.length >= PICKER_SEARCH_FROM_COUNT}
              options={allowedWorkspaces.map((candidate) => ({
                value: candidate.id,
                label: candidate.name
              }))}
              value={form.workspaceId}
              onValueChange={(workspaceId) => change({ workspaceId })}
            >
              <PickerButton
                label={t("access.grantWorkspace")}
                placeholder={t("access.chooseWorkspace")}
                value={workspace?.name}
                disabled={allowedWorkspaces.length === 0}
              />
            </Picker>
          </Field>
        ) : scopeKind === "asset" ? (
          <Field
            label={t(words.assetField)}
            required
            error={assetsError}
            hint={choices.items?.length === 0 ? t(words.noAssets) : undefined}
          >
            <Picker
              search={kindItems.length >= PICKER_SEARCH_FROM_COUNT}
              // What an asset says of itself is what tells two of them apart: shown in full.
              wrapDescriptions
              options={kindItems.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
                leading: kindIcon,
                ...(candidate.description ? { description: candidate.description } : {})
              }))}
              value={form.assetId}
              onValueChange={(assetId) => change({ assetId })}
            >
              <PickerButton
                label={t(words.assetField)}
                placeholder={t(words.chooseAsset)}
                value={asset?.name}
                leading={asset ? kindIcon : undefined}
                disabled={kindItems.length === 0}
              />
            </Picker>
          </Field>
        ) : null}
        {/* A deny is the exception: it is folded away, and open from the start once chosen. */}
        <Disclosure defaultOpen={form.effect === "deny"}>
          <DisclosureTrigger>{t("access.denyToggle")}</DisclosureTrigger>
          <DisclosureContent className="pt-2">
            <Checkbox
              label={t("access.denyChoice")}
              description={
                <>
                  {t("access.effectDenyDescription")} <DocsReference to="rightDenied" />
                </>
              }
              checked={form.effect === "deny"}
              onCheckedChange={(checked) => change({ effect: checked ? "deny" : "allow" })}
            />
          </DisclosureContent>
        </Disclosure>
      </form>
    </Dialog>
  );
}
