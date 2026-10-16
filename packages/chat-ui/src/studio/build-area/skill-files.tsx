import { Download, FilePlus, FileText, Folder, Plus, Replace, Trash2, Upload } from "lucide-react";
import { Fragment } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FilePicker,
  Field,
  IconButton,
  InlineError,
  Input,
  List,
  ListRow,
  Spinner,
  Textarea
} from "@work-shape/catalyst-ui";
import { saveBlobAsFile } from "../../chat/files/conversation-file-content";
import { resolveFileType } from "../../chat/files/file-type";
import { FileTypeIcon } from "../../chat/files/file-type-icon";
import { useTranslation } from "../../shared/i18n";
import {
  formatFileBytes,
  isUnread,
  SKILL_FOLDERS,
  SKILL_ROOT_FILE_NAME,
  skillFileBlob,
  skillFilePath,
  skillFilePlace,
  type SkillFileForm,
  type SkillFolder
} from "./skill-form-model";

/** The file the editor shows: `SKILL.md`, or another file by its place in the form's list. */
export type SkillFileSelection = "root" | number;

/** A file with its place in the form's list, which stays while its path is typed. */
interface PlacedFile {
  file: SkillFileForm;
  at: number;
}

function byPath(left: PlacedFile, right: PlacedFile): number {
  return left.file.path < right.file.path ? -1 : left.file.path > right.file.path ? 1 : 0;
}

/**
 * The folder of a skill as a tree: `SKILL.md`, a file outside the three folders where an older
 * skill has one, and the files of `references/`, `scripts/` and `assets/`. A writer adds a file
 * to a folder from its row.
 */
export function SkillFileList({
  files,
  selected,
  editable,
  onSelect,
  onNew,
  onUpload
}: {
  files: readonly SkillFileForm[];
  selected: SkillFileSelection;
  editable: boolean;
  onSelect(selection: SkillFileSelection): void;
  onNew(folder: SkillFolder): void;
  onUpload(folder: SkillFolder, files: readonly File[]): void;
}) {
  const { t } = useTranslation();
  const sorted = files.map((file, at) => ({ file, at })).sort(byPath);
  const inFolder = (folder: SkillFolder | undefined) =>
    sorted.filter(({ file }) => skillFilePlace(file.path).folder === folder);
  const row = ({ file, at }: PlacedFile, nested: boolean) => (
    <ListRow
      key={at}
      size="compact"
      className={nested ? "pl-6" : undefined}
      data-skill-file={file.path}
      leading={<FileTypeIcon type={resolveFileType({ filename: file.path })} className="size-4" />}
      title={nested ? skillFilePlace(file.path).name : file.path}
      selected={selected === at}
      onClick={() => onSelect(at)}
    />
  );
  return (
    <List aria-label={t("build.skillFiles")}>
      <ListRow
        size="compact"
        data-skill-file={SKILL_ROOT_FILE_NAME}
        leading={<FileText aria-hidden="true" />}
        title={SKILL_ROOT_FILE_NAME}
        selected={selected === "root"}
        onClick={() => onSelect("root")}
      />
      {inFolder(undefined).map((placed) => row(placed, false))}
      {SKILL_FOLDERS.map((folder) => {
        const held = inFolder(folder);
        // A reader sees the folders that hold files. A writer sees all three, to add to them.
        if (held.length === 0 && !editable) return null;
        return (
          <Fragment key={folder}>
            <ListRow
              size="compact"
              data-skill-folder={folder}
              leading={<Folder aria-hidden="true" />}
              title={`${folder}/`}
              actionsVisible
              actions={
                editable ? (
                  <FilePicker multiple onFiles={(chosen) => onUpload(folder, chosen)}>
                    {(choose) => (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            label={t("skillFiles.addTo", { folder: `${folder}/` })}
                            size="sm"
                          >
                            <Plus aria-hidden="true" />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem icon={<Upload aria-hidden="true" />} onSelect={choose}>
                            {t("skillFiles.upload")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={<FilePlus aria-hidden="true" />}
                            onSelect={() => onNew(folder)}
                          >
                            {t("skillFiles.new")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </FilePicker>
                ) : undefined
              }
            />
            {held.map((placed) => row(placed, true))}
          </Fragment>
        );
      })}
    </List>
  );
}

/**
 * One file of the folder: its name, type, size and hash, its text where it is text, and what
 * can be done with it. A file that is no text is replaced as a whole.
 */
export function SkillFilePane({
  file,
  editable,
  read,
  changed,
  onRetryRead,
  onRename,
  onText,
  onReplace,
  onDelete
}: {
  file: SkillFileForm;
  editable: boolean;
  /** How the content of the files the skill's index names is read. */
  read: "idle" | "loading" | "failed";
  /** The file differs from what was loaded or last saved. */
  changed: boolean;
  onRetryRead(): void;
  onRename(path: string): void;
  onText(text: string): void;
  onReplace(file: File): void;
  onDelete(): void;
}) {
  const { locale, t } = useTranslation();
  const place = skillFilePlace(file.path);
  const type = resolveFileType({ filename: file.path });
  const unread = isUnread(file);
  return (
    <div className="grid gap-4" data-skill-file-pane={file.path}>
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label={t("skillFiles.name")} required={editable}>
          <Input
            value={place.name}
            readOnly={!editable}
            onChange={(event) => onRename(skillFilePath(place.folder, event.target.value))}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={unread}
            onClick={() => saveBlobAsFile(skillFileBlob(file), place.name.split("/").at(-1) ?? "")}
          >
            <Download aria-hidden="true" />
            {t("skillFiles.download")}
          </Button>
          {editable ? (
            <>
              <FilePicker onFiles={([chosen]) => (chosen ? onReplace(chosen) : undefined)}>
                {(choose) => (
                  <Button variant="outline" size="sm" onClick={choose}>
                    <Replace aria-hidden="true" />
                    {t("skillFiles.replace")}
                  </Button>
                )}
              </FilePicker>
              <Button variant="ghost" size="sm" onClick={onDelete}>
                <Trash2 aria-hidden="true" />
                {t("skillFiles.delete")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <div className="grid gap-0.5 text-caption text-muted-foreground" data-skill-file-facts="">
        <span>
          {t(type.labelKey)} · {formatFileBytes(file.bytes, locale)}
        </span>
        {changed ? (
          <span>{t("skillFiles.notSaved")}</span>
        ) : file.sha256 === undefined ? null : (
          <span className="font-mono break-all">{t("skillFiles.hash", { hash: file.sha256 })}</span>
        )}
      </div>
      {unread ? (
        read === "failed" ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("skillFiles.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={onRetryRead}>
              {t("tryAgain")}
            </Button>
          </InlineError>
        ) : (
          <p className="flex items-center gap-2 text-caption text-muted-foreground">
            <Spinner size="xs" aria-hidden="true" />
            {t("skillFiles.loading")}
          </p>
        )
      ) : file.text === undefined ? (
        <p className="text-body text-muted-foreground" data-skill-file-binary="">
          {t("skillFiles.binary")}
        </p>
      ) : (
        <Field label={t("skillFiles.content")}>
          <Textarea
            variant="code"
            className="min-h-96"
            value={file.text}
            readOnly={!editable}
            onChange={(event) => onText(event.target.value)}
          />
        </Field>
      )}
    </div>
  );
}
