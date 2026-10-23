import { FolderInput } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SKILL_SUMMARY_MAX_LENGTH, assetAddressFromName } from "@work-shape/catalyst-core";
import { Field, Input, Textarea } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import { FieldRefusals } from "./asset-form-fields";
import { countChangedFields } from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { refusalsOf } from "./build-refusals";
import { SkillFileList, SkillFilePane, type SkillFileSelection } from "./skill-files";
import { SkillReplaceDialog } from "./skill-import";
import {
  clearSkillReplaceRequest,
  requestedSkillReplace,
  type SkillImport
} from "./skill-import-model";
import {
  freeSkillFilePath,
  isUnread,
  skillFileOfBytes,
  skillFilePath,
  skillFolderChanged,
  skillFormToConfig,
  skillFormToFolder,
  textBytes,
  withReadFiles,
  withStoredHashes,
  type SkillFileForm,
  type SkillFolder,
  type SkillFormState
} from "./skill-form-model";

/** Where chosen files go: added to a folder, or in place of a file, by its place. */
type UploadTarget = { folder: SkillFolder } | { replace: number };

/** How the content of the files the skill's index names is read. */
type FolderRead = "idle" | "loading" | "failed";

export function SkillEditor({
  frame,
  initialForm,
  editable: instanceEditable,
  badges
}: {
  frame: BuildAssetEditorProps;
  initialForm: SkillFormState;
  /** The instance lets people change skills here. */
  editable: boolean;
  /** What the page head says of the skill beside its title, such as who ships it. */
  badges?: ReactNode;
}) {
  const { t } = useTranslation();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome, amend } = state;
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<SkillFileSelection>("root");
  const [folderRead, setFolderRead] = useState<FolderRead>("idle");
  const [readAttempt, setReadAttempt] = useState(0);
  const editable = frame.canWrite && instanceEditable;
  const { folder } = frame;
  // "Replace from folder" is open, with the folder an import handed over where it found the
  // skill's address taken.
  const [replacing, setReplacing] = useState<{ initial?: SkillImport } | undefined>(() => {
    const initial = requestedSkillReplace(frame.asset?.name);
    return initial && editable && folder !== undefined ? { initial } : undefined;
  });
  useEffect(clearSkillReplaceRequest, []);
  const unread = form.files.some(isUnread);
  // The page of a new skill asks the instance about the id its name makes.
  const { onNewTitle } = frame;
  useEffect(() => {
    onNewTitle?.(form.title);
  }, [onNewTitle, form.title]);
  // A file of the folder changes only once every file is read: a save then writes them all.
  const filesEditable = editable && folder !== undefined && !unread;

  // The index names the files beside the config without their content. The page reads them
  // once, so a script can be read and edited, and a save of the folder carries every file.
  useEffect(() => {
    if (!unread || folder === undefined) return;
    let current = true;
    setFolderRead("loading");
    folder.read().then(
      (files) => {
        if (!current) return;
        amend((value) => withReadFiles(value, files));
        setFolderRead("idle");
      },
      () => {
        if (current) setFolderRead("failed");
      }
    );
    return () => {
      current = false;
    };
    // The read runs when the page opens and again when the reader asks: the revision it reads
    // stays the page's while the page is open.
  }, [readAttempt]);

  const update = (patch: Partial<SkillFormState>) => setForm((value) => ({ ...value, ...patch }));
  /** Changes the file at a place of the list. A file is known by its place, not its path. */
  const updateFile = (at: number, change: (file: SkillFileForm) => SkillFileForm | undefined) =>
    setForm((value) => ({
      ...value,
      files: value.files.flatMap((file, index) => {
        if (index !== at) return [file];
        const next = change(file);
        return next === undefined ? [] : [next];
      })
    }));

  /** Writes the whole folder, or the config alone, where the files beside it stay. */
  const write = async (written: SkillFormState, wholeFolder: boolean) => {
    setSaving(true);
    const { stored, ...answer } =
      folder !== undefined && wholeFolder
        ? await folder.save(skillFormToFolder(written))
        : { ...(await frame.save(skillFormToConfig(written))), stored: undefined };
    setSaving(false);
    state.setOutcome(answer);
    return { answer, stored };
  };

  const submit = async () => {
    // A file beside SKILL.md changed: the whole folder is written. Otherwise the config is,
    // and the files beside it stay as they are.
    // A new skill on a page opened empty takes its id from its name.
    const written =
      frame.asset === undefined && !form.name.trim()
        ? { ...form, name: assetAddressFromName(form.title, "skill") }
        : form;
    const { answer, stored } = await write(
      written,
      !unread && skillFolderChanged(written, state.baseline)
    );
    if (answer.ok) {
      state.markSaved();
      // A save of the folder answers the hash of every file it stored.
      if (stored) amend((value) => withStoredHashes(value, stored));
    }
    return answer;
  };

  /**
   * Replaces the whole folder with one read from a folder or a .zip, through the page's save:
   * the page shows the new folder, and a refused or waiting save leaves it as changes.
   */
  const replaceWith = async (replaced: SkillFormState) => {
    setReplacing(undefined);
    setSelected("root");
    setForm(replaced);
    const { answer, stored } = await write(replaced, true);
    if (answer.ok) amend(() => (stored ? withStoredHashes(replaced, stored) : replaced));
  };

  const takeFiles = async (target: UploadTarget, chosen: readonly File[]) => {
    const files = [...form.files];
    let last: number | undefined;
    for (const chosenFile of chosen) {
      const bytes = new Uint8Array(await chosenFile.arrayBuffer());
      // A replaced file keeps its path. An upload of a name the folder holds replaces that
      // file; every other one is added.
      const at =
        "replace" in target
          ? target.replace
          : files.findIndex((file) => file.path === skillFilePath(target.folder, chosenFile.name));
      const path =
        "replace" in target
          ? (files[target.replace]?.path ?? chosenFile.name)
          : skillFilePath(target.folder, chosenFile.name);
      const next = skillFileOfBytes(path, bytes);
      if (at >= 0 && at < files.length) {
        files[at] = next;
        last = at;
      } else {
        last = files.push(next) - 1;
      }
    }
    setForm((value) => ({ ...value, files }));
    if (last !== undefined) setSelected(last);
  };
  const addEmptyFile = (folderName: SkillFolder) => {
    const path = freeSkillFilePath(form.files, folderName);
    setForm((value) => ({ ...value, files: [...value.files, { path, bytes: 0, text: "" }] }));
    setSelected(form.files.length);
  };

  const file = selected === "root" ? undefined : form.files[selected];
  const at = selected === "root" ? -1 : selected;
  const savedFile = file && state.baseline.files.find((candidate) => candidate.path === file.path);
  // A file that differs from what was loaded or last saved has no stored hash yet.
  const fileChanged =
    savedFile === undefined || savedFile.text !== file?.text || savedFile.base64 !== file?.base64;
  const fileRefusals = refusalsOf(outcome, "files");

  const sections: AssetSection[] = [
    {
      id: "details",
      label: t("configSkillDetails"),
      description: t("configSkillDetailsDescription"),
      body: (
        <>
          <Field label={t("configTitle")} hint={t("configSkillTitleHint")} required={editable}>
            <Input
              value={form.title}
              readOnly={!editable}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field
            label={t("configDescription")}
            hint={t("configSkillDescriptionHint")}
            required={editable}
          >
            <Input
              value={form.description}
              readOnly={!editable}
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>
          <Field label={t("build.skillSummary")} hint={t("build.skillSummaryHint")}>
            <Input
              value={form.summary}
              maxLength={SKILL_SUMMARY_MAX_LENGTH}
              placeholder={editable ? t("build.skillSummaryPlaceholder") : undefined}
              readOnly={!editable}
              onChange={(event) => update({ summary: event.target.value })}
            />
          </Field>
        </>
      )
    },
    {
      id: "files",
      label: t("skillFiles.title"),
      description: t("skillFiles.description"),
      count: form.files.length + 1,
      refusalField: "files",
      body: (
        <>
          <SkillFileList
            files={form.files}
            selected={selected}
            editable={filesEditable}
            onSelect={setSelected}
            onNew={addEmptyFile}
            onUpload={(folderName, chosen) => {
              takeFiles({ folder: folderName }, chosen).catch(() => undefined);
            }}
          />
          <FieldRefusals messages={fileRefusals} />
          {file === undefined ? (
            <Field
              label={t("configContent")}
              hint={t("configSkillContentHint")}
              required={editable}
            >
              <Textarea
                variant="code"
                className="min-h-96"
                value={form.content}
                readOnly={!editable}
                onChange={(event) => update({ content: event.target.value })}
              />
            </Field>
          ) : (
            <SkillFilePane
              file={file}
              editable={filesEditable}
              read={folderRead}
              onRetryRead={() => setReadAttempt((attempt) => attempt + 1)}
              changed={fileChanged}
              onRename={(path) => updateFile(at, (candidate) => ({ ...candidate, path }))}
              onText={(text) =>
                updateFile(at, (candidate) => ({
                  path: candidate.path,
                  bytes: textBytes(text),
                  text
                }))
              }
              onReplace={(chosen) => {
                takeFiles({ replace: at }, [chosen]).catch(() => undefined);
              }}
              onDelete={() => {
                updateFile(at, () => undefined);
                setSelected("root");
              }}
            />
          )}
        </>
      )
    }
  ];

  const shell = (
    <AssetEditorShell
      frame={{ ...frame, canWrite: editable }}
      title={form.title.trim() || form.name || t("configNewSkill")}
      description={form.summary.trim()}
      badges={badges}
      headActions={
        editable && folder !== undefined && frame.asset !== undefined
          ? [
              {
                label: t("skillImport.replaceAction"),
                icon: <FolderInput aria-hidden="true" />,
                onSelect: () => setReplacing({})
              }
            ]
          : undefined
      }
      sections={sections}
      control={{
        changes: countChangedFields(form, state.baseline),
        submit,
        discard: () => {
          state.discard();
          setSelected("root");
        }
      }}
      outcome={outcome}
      saving={saving}
      saveLabel={frame.asset ? t("configSaveChanges") : t("configCreateSkill")}
    />
  );
  return (
    <>
      {shell}
      {replacing ? (
        <SkillReplaceDialog
          title={form.title.trim() || form.name}
          current={state.baseline}
          unsaved={countChangedFields(form, state.baseline) > 0}
          initial={replacing.initial}
          onClose={() => setReplacing(undefined)}
          onSave={(replaced) => {
            replaceWith(replaced).catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );
}
