import { FileArchive, Folder, FolderOpen } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { SKILL_NAME_PATTERN } from "@work-shape/catalyst-core";
import {
  Banner,
  Button,
  Dialog,
  Field,
  FileDropZone,
  FilePicker,
  InlineError,
  Input,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Spinner
} from "@work-shape/catalyst-ui";
import { resolveFileType } from "../../chat/files/file-type";
import { FileTypeIcon } from "../../chat/files/file-type-icon";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { BuildImportDialogProps } from "./build-asset-kind";
import { folderRefusal, waitingNotice, type BuildWriteOutcome } from "./build-refusals";
import { useAddressCheck } from "./name-check";
import { formatFileBytes, skillFormToFolder, type SkillFormState } from "./skill-form-model";
import {
  chosenSource,
  diffSkillFolders,
  droppedSource,
  readSkillSource,
  requestSkillReplace,
  type SkillFolderDiff,
  type SkillImport,
  type SkillImportRefusal,
  type SkillImportSource
} from "./skill-import-model";

type Translate = TranslationContextValue["t"];

/** What a refusal of a folder or an archive says, by path, in the reader's language. */
function refusalMessage(refusal: SkillImportRefusal, t: Translate, locale: LocaleCode): string {
  switch (refusal.reason) {
    case "import_link":
      return t("skillImport.link", { path: refusal.path });
    case "import_archive_too_large":
      return t("skillImport.archiveTooLarge", {
        size: formatFileBytes(refusal.actual, locale),
        limit: formatFileBytes(refusal.limit, locale)
      });
    case "import_archive_unreadable":
      return t("skillImport.archiveUnreadable");
    case "import_no_skill":
      return t("skillImport.noSkill");
    case "import_manifest_invalid":
      return t("skillImport.manifestInvalid", { reason: refusal.message });
    default:
      return folderRefusal(refusal, t, locale) ?? refusal.reason;
  }
}

/** Where reading what a person handed over stands. */
type Reading =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "refused"; messages: string[] }
  | { state: "read"; skill: SkillImport };

/** Reads a folder or a .zip as a skill, from a drop or one of the two file dialogs. */
function useSkillReading(initial?: SkillImport) {
  const { locale, t } = useTranslation();
  const [reading, setReading] = useState<Reading>(
    initial ? { state: "read", skill: initial } : { state: "idle" }
  );
  const take = (source: Promise<SkillImportSource>) => {
    setReading({ state: "reading" });
    source.then(readSkillSource).then(
      (read) =>
        setReading(
          read.ok
            ? { state: "read", skill: read.skill }
            : {
                state: "refused",
                messages: read.refusals.map((refusal) => refusalMessage(refusal, t, locale))
              }
        ),
      () => setReading({ state: "refused", messages: [t("skillImport.archiveUnreadable")] })
    );
  };
  return { reading, take, reset: () => setReading({ state: "idle" }) };
}

/** The zone a folder or a .zip is dropped on, with the dialogs for each, and what went wrong. */
function SkillSourcePicker({
  reading,
  onSource
}: {
  reading: Reading;
  onSource(source: Promise<SkillImportSource>): void;
}) {
  const { t } = useTranslation();
  const busy = reading.state === "reading";
  return (
    <div className="grid gap-3">
      <FileDropZone disabled={busy} onDrop={(data) => onSource(droppedSource(data))}>
        {busy ? (
          <span className="flex items-center gap-2" data-skill-import-reading="">
            <Spinner size="xs" aria-hidden="true" />
            {t("skillImport.reading")}
          </span>
        ) : (
          <>
            <span>{t("skillImport.drop")}</span>
            <div className="flex flex-wrap justify-center gap-2">
              <FilePicker
                accept=".zip,application/zip"
                onFiles={(files) => onSource(Promise.resolve(chosenSource(files)))}
              >
                {(choose) => (
                  <Button variant="outline" size="sm" onClick={choose}>
                    <FileArchive aria-hidden="true" />
                    {t("skillImport.chooseZip")}
                  </Button>
                )}
              </FilePicker>
              <FilePicker
                directory
                onFiles={(files) => onSource(Promise.resolve(chosenSource(files)))}
              >
                {(choose) => (
                  <Button variant="outline" size="sm" onClick={choose}>
                    <FolderOpen aria-hidden="true" />
                    {t("skillImport.chooseFolder")}
                  </Button>
                )}
              </FilePicker>
            </div>
          </>
        )}
      </FileDropZone>
      {reading.state === "refused" ? (
        <InlineError className="grid gap-1" data-skill-import-refused="">
          {reading.messages.map((message) => (
            <span key={message}>{message}</span>
          ))}
        </InlineError>
      ) : null}
    </div>
  );
}

/** The files of a folder by folder, each with its size, under their count and their total. */
function SkillImportFiles({ files }: { files: SkillImport["files"] }) {
  const { locale, t } = useTranslation();
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : 1));
  const root = sorted.filter((file) => !file.path.includes("/"));
  const folders = [
    ...new Set(
      sorted.filter((file) => file.path.includes("/")).map((file) => file.path.split("/")[0] ?? "")
    )
  ];
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const row = (file: { path: string; bytes: number }, name: string, nested: boolean) => (
    <ListRow
      key={file.path}
      size="compact"
      className={nested ? "pl-6" : undefined}
      data-skill-import-file={file.path}
      leading={<FileTypeIcon type={resolveFileType({ filename: file.path })} className="size-4" />}
      title={name}
      time={formatFileBytes(file.bytes, locale)}
    />
  );
  return (
    <div className="grid gap-2">
      <p className="text-caption text-muted-foreground" data-skill-import-count="">
        {t("skillImport.files", {
          count: String(files.length),
          size: formatFileBytes(total, locale)
        })}
      </p>
      <List aria-label={t("skillFiles.title")} className="max-h-72 overflow-y-auto">
        {root.map((file) => row(file, file.path, false))}
        {folders.map((folder) => (
          <Fragment key={folder}>
            <ListRow size="compact" leading={<Folder aria-hidden="true" />} title={`${folder}/`} />
            {sorted
              .filter((file) => file.path.startsWith(`${folder}/`))
              .map((file) => row(file, file.path.slice(folder.length + 1), true))}
          </Fragment>
        ))}
      </List>
    </div>
  );
}

/** What a save's answer says in a dialog: a wait for an approval, or the refusals by path. */
function OutcomeNotice({ outcome }: { outcome: BuildWriteOutcome | undefined }) {
  if (outcome === undefined || outcome.ok) return null;
  const waiting = waitingNotice(outcome);
  if (waiting !== undefined) return <Banner tone="info">{waiting}</Banner>;
  if (outcome.conflict) return null;
  return (
    <InlineError className="grid gap-1" data-skill-import-refused="">
      {outcome.refusals.map((refusal) => (
        <span key={refusal.message}>{refusal.message}</span>
      ))}
    </InlineError>
  );
}

/**
 * "Import skill": a folder or a .zip is read here, shown with its name, title, description and
 * files, and created as a new skill where Studio makes one. An address that is taken offers to
 * replace the files of the skill that holds it instead, on that skill's page.
 */
export function SkillImportDialog({
  checkName,
  create,
  titleOf,
  onClose,
  onOpen
}: BuildImportDialogProps) {
  const { t } = useTranslation();
  const { reading, take, reset } = useSkillReading();
  const skill = reading.state === "read" ? reading.skill : undefined;
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [outcome, setOutcome] = useState<BuildWriteOutcome>();
  const [taken, setTaken] = useState<{ name: string; title: string }>();
  useEffect(() => {
    setName(skill?.form.name ?? "");
    setOutcome(undefined);
  }, [skill]);
  const id = name.trim();
  const valid = SKILL_NAME_PATTERN.test(id);
  const check = useAddressCheck(
    skill && valid
      ? async (asked) => {
          const answer = await checkName(asked);
          if (!answer.available && answer.reason === "name_taken") {
            const title = (await titleOf(asked).catch(() => undefined)) ?? asked;
            setTaken({ name: asked, title });
          }
          return answer;
        }
      : undefined,
    id
  );
  const isTaken = check.state === "refused" && taken?.name === id;
  const nameError = !valid && id !== "" ? t("skillImport.nameInvalid") : undefined;
  const checkError = check.state === "refused" && !isTaken ? check.reason : undefined;

  const submit = async () => {
    if (!skill || !valid) return;
    setCreating(true);
    const answer = await create({
      name: id,
      files: skillFormToFolder({ ...skill.form, name: id })
    });
    setCreating(false);
    if (answer.ok) onOpen(id);
    else setOutcome(answer);
  };

  return (
    <Dialog
      open
      size="md"
      title={t("skillImport.action")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          {skill && isTaken && taken ? (
            <Button
              data-skill-import-replace=""
              onClick={() => {
                requestSkillReplace(id, skill);
                onOpen(id);
              }}
            >
              {t("skillImport.replace", { title: taken.title })}
            </Button>
          ) : (
            <Button
              loading={creating}
              disabled={!skill || !valid || check.state === "refused" || creating}
              onClick={() => {
                submit().catch(() => setCreating(false));
              }}
            >
              {t("skillImport.create")}
            </Button>
          )}
        </>
      }
    >
      {skill === undefined ? (
        <SkillSourcePicker reading={reading} onSource={take} />
      ) : (
        <div className="grid gap-4" data-skill-import-preview="">
          <KeyValueList layout="stacked">
            <KeyValue label={t("configTitle")}>{skill.form.title}</KeyValue>
            <KeyValue label={t("configDescription")}>{skill.form.description}</KeyValue>
          </KeyValueList>
          <Field
            label={t("build.createAddress")}
            hint={t("skillImport.nameHint")}
            error={nameError ?? checkError}
            required
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          {isTaken ? (
            <Banner tone="warning" data-skill-import-taken="">
              {t("skillImport.nameTaken", { name: id })}
            </Banner>
          ) : null}
          <SkillImportFiles files={skill.files} />
          <OutcomeNotice outcome={outcome} />
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={reset}>
            {t("skillImport.chooseAnother")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

/** One group of the replace's changes: its heading with the count, and its files. */
function DiffGroup({
  label,
  kind,
  rows
}: {
  label: string;
  kind: "added" | "changed" | "removed";
  rows: { path: string; size: string }[];
}) {
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-1" data-skill-replace-group={kind}>
      <h3 className="text-label">
        {label} · {rows.length}
      </h3>
      <List aria-label={label}>
        {rows.map((row) => (
          <ListRow
            key={row.path}
            size="compact"
            data-skill-replace-file={row.path}
            leading={
              <FileTypeIcon type={resolveFileType({ filename: row.path })} className="size-4" />
            }
            title={row.path}
            time={row.size}
          />
        ))}
      </List>
    </section>
  );
}

/**
 * "Replace from folder" on a skill's page: a folder or a .zip is read, the files it adds,
 * changes and removes are listed, and Save writes the whole folder at the page's revision
 * through the page's own save. The skill keeps its address.
 */
export function SkillReplaceDialog({
  title,
  current,
  unsaved,
  initial,
  onClose,
  onSave
}: {
  title: string;
  /** The skill as the page last loaded or saved it. */
  current: SkillFormState;
  /** The page holds changes that are not saved: the replace drops them. */
  unsaved: boolean;
  /** A folder read already, such as by the import that found the address taken. */
  initial?: SkillImport;
  onClose(): void;
  onSave(form: SkillFormState): void;
}) {
  const { locale, t } = useTranslation();
  const { reading, take, reset } = useSkillReading(initial);
  const skill = reading.state === "read" ? reading.skill : undefined;
  const replaced = skill ? { ...skill.form, name: current.name } : undefined;
  const [diff, setDiff] = useState<SkillFolderDiff>();
  useEffect(() => {
    setDiff(undefined);
    if (replaced === undefined) return;
    let live = true;
    diffSkillFolders(current, replaced).then(
      (found) => live && setDiff(found),
      () => undefined
    );
    return () => {
      live = false;
    };
    // The diff follows the folder read; the page's skill stays while the dialog is open.
  }, [skill]);
  const size = (bytes: number) => formatFileBytes(bytes, locale);
  const changes = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0;

  return (
    <Dialog
      open
      size="md"
      title={t("skillImport.replace", { title })}
      description={t("skillImport.replaceDescription")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={replaced === undefined || diff === undefined || changes === 0}
            onClick={() => (replaced ? onSave(replaced) : undefined)}
          >
            {t("configSaveChanges")}
          </Button>
        </>
      }
    >
      {skill === undefined ? (
        <SkillSourcePicker reading={reading} onSource={take} />
      ) : diff === undefined ? (
        <Spinner size="sm" />
      ) : (
        <div className="grid gap-4" data-skill-replace-diff="">
          {changes === 0 ? (
            <p className="text-body text-muted-foreground">{t("skillImport.noChanges")}</p>
          ) : (
            <>
              <DiffGroup
                label={t("skillImport.added")}
                kind="added"
                rows={diff.added.map((file) => ({ path: file.path, size: size(file.bytes) }))}
              />
              <DiffGroup
                label={t("skillImport.changed")}
                kind="changed"
                rows={diff.changed.map((file) => ({
                  path: file.path,
                  size: t("skillImport.sizeChange", {
                    before: size(file.before),
                    after: size(file.bytes)
                  })
                }))}
              />
              <DiffGroup
                label={t("skillImport.removed")}
                kind="removed"
                rows={diff.removed.map((file) => ({ path: file.path, size: size(file.bytes) }))}
              />
            </>
          )}
          {diff.unchanged > 0 ? (
            <p className="text-caption text-muted-foreground">
              {t("skillImport.unchanged", { count: String(diff.unchanged) })}
            </p>
          ) : null}
          {unsaved && changes > 0 ? (
            <Banner tone="warning">{t("skillImport.unsaved")}</Banner>
          ) : null}
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={reset}>
            {t("skillImport.chooseAnother")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
