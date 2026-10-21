import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import type { FlowChange } from "@work-shape/catalyst-ui";
import { instanceSentence, readRefusalDetails } from "../build-area/build-refusals";
import { useTranslation } from "../../shared/i18n";
import { draftChanges, withRemovedSteps, type DraftChanges } from "./draft-changes";
import type { WorkflowIssue } from "./source-shapes";
import {
  applyFileEdits,
  applyStepEdits,
  effectiveEdits,
  findStep,
  rebaseStepEdits,
  type EditConflict,
  type StepEdit,
  type WorkflowFile,
  type WorkflowManifest,
  workflowFiles
} from "./step-edits";
import { useWorkflowEditWrites, useWorkflowRevision } from "./workflow-data";
import { workflowSteps } from "./workflow-mapping";
import type {
  WorkflowDefinitionView,
  WorkflowStepFacts,
  WorkflowStepView,
  WorkflowView
} from "./workflow-views";

// Editing a Workflow by hand on its page (workflow-canvas 9.4 and 9.5): the operations a person
// made and has not saved, what the canvas draws of them, the save with the rebase after a
// `412` (a revision conflict), and what the instance says of each field. The Settings tab of a step reads and
// changes this; the canvas draws it.

const isStepRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the instance refuses, by the step and the field it names. */
export interface EditIssues {
  /** By `<step>:<field>`, and by `<step>:<field>.<name>` for one value of a mapping. */
  fields: ReadonlyMap<string, string>;
  /** What names no field the form shows. */
  other: readonly string[];
}

const NO_ISSUES: EditIssues = { fields: new Map(), other: [] };

/**
 * Where in the manifest an issue of the instance is: its step and its field, as far as named.
 * The definition's checks name a step by its id (`steps.<id>.input.x`); the schema's own check
 * names it by its position in its list (`steps.2.steps.0.name`).
 */
export function issuePlace(
  path: readonly string[],
  manifest: WorkflowManifest
): { step: string; field?: string; name?: string } | undefined {
  const parts = path
    .join(".")
    .replace(/\[(\d+)\]/gu, ".$1")
    .replace(/^manifest\./u, "")
    .split(".")
    .filter((part) => part !== "");
  let list: unknown = manifest.steps;
  let step: Readonly<Record<string, unknown>> | undefined;
  let at = 0;
  // Down the lists of steps: a loop's body and the paths of a condition hold steps too.
  while (at < parts.length - 1 && ["steps", "then", "else"].includes(parts[at] ?? "")) {
    const key = parts[at + 1] ?? "";
    const next = /^\d+$/u.test(key)
      ? Array.isArray(list)
        ? (list[Number(key)] as unknown)
        : undefined
      : step === undefined && parts[at] === "steps"
        ? findStep(manifest, key)
        : undefined;
    if (!isStepRecord(next)) break;
    step = next;
    at += 2;
    list = step[parts[at] ?? ""];
  }
  const id = step?.id;
  if (typeof id !== "string") return undefined;
  const [field, name] = parts.slice(at);
  return {
    step: id,
    ...(field === undefined ? {} : { field }),
    ...(name === undefined ? {} : { name })
  };
}

/** The issues by the field they name. Those that name none the form shows stand apart. */
export function editIssues(
  issues: readonly WorkflowIssue[],
  manifest: WorkflowManifest
): EditIssues {
  const fields = new Map<string, string>();
  const other: string[] = [];
  for (const issue of issues) {
    const place = issuePlace(issue.path, manifest);
    if (place?.field === undefined) {
      other.push(issue.message);
      continue;
    }
    const key =
      place.name === undefined
        ? `${place.step}:${place.field}`
        : `${place.step}:${place.field}.${place.name}`;
    if (!fields.has(key)) fields.set(key, issue.message);
    // A value of a mapping is shown under its row; the field itself names it too.
    const whole = `${place.step}:${place.field}`;
    if (!fields.has(whole)) fields.set(whole, issue.message);
  }
  return { fields, other };
}

/** The instance holds another revision than the one the save was made from: 412. */
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 412;

/** How the canvas marks a part, and the published step a changed one was. */
export interface StepMark {
  change: FlowChange;
  /** The published step, for the sentence it had. */
  was?: WorkflowStepView;
}

/** Editing by hand of one Workflow, for a reader who may write it. */
export interface WorkflowEditing {
  /** The draft with what is not saved: what the canvas draws and the form shows. */
  manifest: WorkflowManifest;
  /** The files of the draft with what is not saved: the scripts of code steps. */
  files: readonly WorkflowFile[];
  /** The steps the canvas draws: the edited draft's, with the removed ones put back. */
  steps: readonly WorkflowStepView[];
  marks: ReadonlyMap<string, StepMark>;
  /** The published revision, once read. Absent before the first publish. */
  published: WorkflowManifest | undefined;
  /** How the saved draft differs from the published revision. */
  changes: DraftChanges;
  stepFacts: WorkflowStepFacts | undefined;
  /** The steps with values that are not saved. */
  unsaved: ReadonlySet<string>;
  set(step: string, fields: Readonly<Record<string, unknown>>): void;
  /** Takes the agent's value of a field the agent changed meanwhile. */
  takeTheirs(step: string, field: string): void;
  /** Drops what is not saved of one step. */
  cancel(step: string): void;
  /**
   * Holds the save of a step back, or lets it go, for a value the form has not finished, such
   * as an answer field with no name yet. `key` tells the holds of one step apart.
   */
  hold(step: string, key: string, held: boolean): void;
  /** The steps whose save is held back. */
  held: ReadonlySet<string>;
  /** Asks the instance what it would refuse now, as a field loses focus. */
  validate(): void;
  save(): Promise<void>;
  saving: boolean;
  issues: EditIssues;
  /** Fields the agent changed while the person changed them too, with the agent's value. */
  conflicts: readonly EditConflict[];
  /** Steps the agent deleted while the person changed them: the change was dropped. */
  dropped: readonly string[];
  /** Why the last save failed, where no field says it. */
  error: string | undefined;
}

/**
 * Editing by hand of the Workflow the page shows. Nothing where the reader may not write it
 * or the source holds no drafts. A draft the agent saves meanwhile is taken as the new base at
 * once: the edits are carried over to it and the canvas draws both.
 */
export function useWorkflowEditing(input: {
  workspaceId: string;
  workflowId: string;
  workflow: WorkflowView | undefined;
  /** The reader may write the Workflow. */
  mayWrite: boolean;
}): WorkflowEditing | undefined {
  const { t } = useTranslation();
  const writes = useWorkflowEditWrites();
  const definition = input.workflow?.definition;
  const publishedRevision = input.workflow?.draft?.publishedRevision;
  const publishedDefinition = useWorkflowRevision(
    input.workflowId,
    // The published revision is the draft where nothing differs: it is read once only.
    publishedRevision !== undefined && publishedRevision !== definition?.revision
      ? publishedRevision
      : undefined
  );
  const [edits, setEdits] = useState<StepEdit[]>([]);
  const [base, setBase] = useState(definition);
  const [conflicts, setConflicts] = useState<EditConflict[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [issues, setIssues] = useState<EditIssues>(NO_ISSUES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [holds, setHolds] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(0);

  // A draft another writer saved becomes the base; what is not saved is carried over to it.
  const latest = definition;
  if (latest !== undefined && (base === undefined || latest.revision > base.revision)) {
    if (base !== undefined && edits.length > 0) {
      const rebased = rebaseStepEdits({
        base: base.manifest,
        latest: latest.manifest,
        edits,
        baseFiles: workflowFiles(base.config),
        latestFiles: workflowFiles(latest.config)
      });
      setEdits(rebased.edits);
      setConflicts((before) => [
        ...before.filter(
          (old) => !rebased.conflicts.some((c) => c.step === old.step && c.field === old.field)
        ),
        ...rebased.conflicts
      ]);
      if (rebased.dropped.length > 0) setDropped((before) => [...before, ...rebased.dropped]);
    }
    setBase(latest);
  } else if (
    latest !== undefined &&
    base !== undefined &&
    latest.revision === base.revision &&
    latest !== base
  ) {
    // The same revision as read: what the instance knows of its steps may be newer.
    setBase(latest);
  }

  const baseManifest = base?.manifest;
  const manifest = useMemo(
    () => (baseManifest === undefined ? {} : applyStepEdits(baseManifest, edits)),
    [baseManifest, edits]
  );
  const baseConfig = base?.config;
  const baseFiles = useMemo(() => workflowFiles(baseConfig), [baseConfig]);
  const files = useMemo(
    () => (baseManifest === undefined ? [] : applyFileEdits(manifest, baseFiles, edits)),
    [baseManifest, manifest, baseFiles, edits]
  );
  const unsavedEdits = useMemo(
    () => (baseManifest === undefined ? [] : effectiveEdits(baseManifest, edits, baseFiles)),
    [baseManifest, edits, baseFiles]
  );
  const published =
    publishedRevision === undefined
      ? undefined
      : publishedRevision === definition?.revision
        ? definition.manifest
        : publishedDefinition?.manifest;
  const stepFacts = base?.stepFacts;
  const changes = useMemo(
    () =>
      baseManifest === undefined
        ? draftChanges(undefined, {})
        : draftChanges(published, baseManifest),
    [published, baseManifest]
  );
  const drawn = useMemo(() => {
    const now = draftChanges(published, manifest);
    const publishedSteps = published === undefined ? [] : workflowSteps(published, stepFacts);
    return {
      now,
      publishedSteps,
      steps: withRemovedSteps(workflowSteps(manifest, stepFacts), publishedSteps, now.removed)
    };
  }, [published, manifest, stepFacts]);
  const unsaved = useMemo(() => new Set(unsavedEdits.map((edit) => edit.step)), [unsavedEdits]);
  const marks = useMemo(() => {
    const found = new Map<string, StepMark>();
    const publishedById = new Map<string, WorkflowStepView>();
    const walk = (list: readonly WorkflowStepView[]) => {
      for (const step of list) {
        publishedById.set(step.id, step);
        walk(step.steps);
        for (const branch of step.branches ?? []) walk(branch.steps);
      }
    };
    walk(drawn.publishedSteps);
    for (const [id, change] of drawn.now.steps) {
      const was = publishedById.get(id);
      found.set(id, { change, ...(was === undefined ? {} : { was }) });
    }
    for (const id of unsaved) {
      const was = publishedById.get(id);
      found.set(id, { change: "unsaved", ...(was === undefined ? {} : { was }) });
    }
    return found;
  }, [drawn, unsaved]);

  // A new base drops the issues of the old one: they name what was asked then.
  useEffect(() => {
    setIssues(NO_ISSUES);
  }, [base?.revision]);

  // What a save that is under way finds when it is answered: the draft may have been read
  // again, and changes made, while it waited.
  const live = useRef({ base, edits, conflicts });
  useEffect(() => {
    live.current = { base, edits, conflicts };
  }, [base, edits, conflicts]);

  if (!input.mayWrite || writes === undefined || base === undefined) {
    return undefined;
  }
  /** The config of a draft with these operations applied: its manifest and its files. */
  const configOf = (from: WorkflowDefinitionView, operations: readonly StepEdit[]) => {
    const manifestNow = applyStepEdits(from.manifest, operations);
    const filesBefore = workflowFiles(from.config);
    const filesNow = applyFileEdits(manifestNow, filesBefore, operations);
    return {
      ...from.config,
      manifest: manifestNow,
      // A config without files gets them only once a script is written.
      ...(filesNow.length === 0 && !Array.isArray(from.config.files) ? {} : { files: filesNow })
    };
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    let from = base;
    let pending = edits;
    try {
      // One save, and once more after a revision conflict where the agent changed none of the fields.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const config = configOf(from, pending);
          const saved = config.manifest;
          const { revision } = await writes.save(input.workflowId, config, from.revision);
          // What was saved is the base at once: a change made before the draft is read again
          // is carried over from it, not from the revision before it.
          setBase((current) =>
            current !== undefined && current.revision >= revision
              ? current
              : { ...from, config, manifest: saved, revision }
          );
          // What was changed while the save waited stays to be saved.
          setEdits((current) => current.filter((edit) => !pending.includes(edit)));
          setConflicts([]);
          setIssues(NO_ISSUES);
          return;
        } catch (failure) {
          if (!isConflict(failure) || attempt > 0) throw failure;
          const now = (await writes.reread(input.workspaceId, input.workflowId)).definition;
          if (now === undefined) throw failure;
          // The changes as they are now: the person may have changed more, or taken the
          // agent's value, while the save waited, and the newer draft may be read already.
          const current = live.current;
          if (current.base === undefined) throw failure;
          let next = { base: current.base, edits: current.edits, conflicts: current.conflicts };
          if (now.revision > current.base.revision) {
            const rebased = rebaseStepEdits({
              baseFiles: workflowFiles(current.base.config),
              latestFiles: workflowFiles(now.config),
              base: current.base.manifest,
              latest: now.manifest,
              edits: current.edits
            });
            next = { base: now, edits: rebased.edits, conflicts: rebased.conflicts };
            live.current = next;
            setBase(now);
            setEdits(rebased.edits);
            setConflicts(rebased.conflicts);
            if (rebased.dropped.length > 0) {
              setDropped((before) => [...before, ...rebased.dropped]);
            }
          }
          // The person decides: their value stands, the agent's is shown under it.
          if (next.conflicts.length > 0) return;
          // Nothing is left to save where every change was to a step the agent deleted.
          if (
            effectiveEdits(next.base.manifest, next.edits, workflowFiles(next.base.config))
              .length === 0
          ) {
            return;
          }
          from = next.base;
          pending = next.edits;
        }
      }
    } catch (failure) {
      const refused = readRefusalDetails(failure).issues;
      if (refused.length > 0) {
        setIssues(
          editIssues(
            refused.map((issue) => ({
              message: issue.message,
              path: issue.path.map(String),
              ...(issue.code === undefined ? {} : { code: issue.code })
            })),
            applyStepEdits(from.manifest, pending)
          )
        );
      } else {
        setError(instanceSentence(failure) ?? t("workflows.settings.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const heldSteps = new Set([...holds].map((key) => key.slice(0, key.indexOf("\n"))));

  return {
    manifest,
    files,
    steps: drawn.steps,
    marks,
    published,
    changes,
    stepFacts,
    unsaved,
    set: (step, fields) => {
      setEdits((before) => [...before, { kind: "set", step, fields }]);
      setError(undefined);
    },
    takeTheirs: (step, field) => {
      setEdits((before) =>
        before.flatMap((edit) => {
          if (edit.step !== step || !(field in edit.fields)) return [edit];
          const { [field]: _taken, ...rest } = edit.fields;
          return Object.keys(rest).length === 0 ? [] : [{ ...edit, fields: rest }];
        })
      );
      setConflicts((before) => before.filter((c) => c.step !== step || c.field !== field));
    },
    cancel: (step) => {
      setEdits((before) => before.filter((edit) => edit.step !== step));
      setHolds((before) => new Set([...before].filter((key) => !key.startsWith(`${step}\n`))));
      setConflicts((before) => before.filter((c) => c.step !== step));
      setIssues(NO_ISSUES);
      setError(undefined);
    },
    hold: (step, key, held) => {
      const entry = `${step}\n${key}`;
      setHolds((before) => {
        if (before.has(entry) === held) return before;
        const next = new Set(before);
        if (held) next.add(entry);
        else next.delete(entry);
        return next;
      });
    },
    held: heldSteps,
    validate: () => {
      if (unsavedEdits.length === 0) return;
      asked.current += 1;
      const ask = asked.current;
      const checked = manifest;
      writes
        .validate(input.workflowId, configOf(base, edits))
        .then((found) => {
          // An answer to an older question says nothing of the form as it is now.
          if (ask === asked.current) setIssues(editIssues(found, checked));
        })
        .catch(() => undefined);
    },
    save,
    saving,
    issues,
    conflicts,
    dropped,
    error
  };
}
