import { useState, type ReactElement } from "react";
import { WORKFLOW_EXECUTED_STEP_TYPES } from "@work-shape/catalyst-core";
import { Picker, type PickerOption, type PickerOptionGroup } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { MAIL_OPERATION, MAIL_SYSTEM_SENDER } from "./mail-step";
import { noteOf, operationWords } from "./operation-picker";
import { fieldsSchema } from "./schema-fields";
import { SCRIPT_FIELD } from "./step-edits";
import type { Translate } from "./step-settings-parts";
import { useCallableOperations } from "./workflow-data";
import type { CallableOperationOption } from "./workflow-views";

// The palette of the "+" on the canvas (workflow-canvas 9.6, WF-EDIT-4): the step types this
// release runs, grouped as a person looks for them, each callable operation by its title. The
// trigger and the result are one per Workflow and never offered. A picked entry is a new step,
// not saved, whose Settings open at once.

/** A new step as the palette makes it: its name, and its fields once its id is known. */
export interface NewStep {
  name: string;
  fields(id: string): Readonly<Record<string, unknown>>;
}

/**
 * A type the palette offers: one this release runs. A type the engine stops running fails the
 * build here, so the palette never offers it.
 */
type Offered = Exclude<(typeof WORKFLOW_EXECUTED_STEP_TYPES)[number], "trigger" | "output">;

const OPERATION = "operation:";
/** The operation that sends an e-mail: offered under People, where the person may send. */
const MAIL = MAIL_OPERATION;

/** What the palette calls an operation, and so the new step. */
const operationName = (operation: CallableOperationOption, t: Translate) =>
  operation.name === MAIL ? t("workflows.palette.mail") : operationWords(operation, t).label;

/** The entries of the palette that are no operation, by their value. */
function plainEntries(t: Translate): Record<string, NewStep & { type: Offered }> {
  const empty = () => fieldsSchema([]);
  const declared = (name: string, type: "agent" | "code") => ({
    name,
    inputSchema: empty(),
    outputSchema: empty(),
    input: {},
    type
  });
  const script = (name: string, ending: string): NewStep & { type: Offered } => ({
    type: "code",
    name,
    // The language is chosen here once: it names the script's file (9.4, Code).
    fields: (id) => ({ ...declared(name, "code"), file: `${id}.${ending}`, [SCRIPT_FIELD]: "" })
  });
  const agentName = t("workflows.palette.agent");
  const loopName = t("workflows.palette.loop");
  const childName = t("workflows.palette.child");
  const notifyName = t("workflows.palette.notify");
  return {
    agent: {
      type: "agent",
      name: agentName,
      fields: () => ({ ...declared(agentName, "agent"), instructions: "" })
    },
    python: script(t("workflows.palette.python"), "py"),
    javascript: script(t("workflows.palette.javascript"), "js"),
    loop: {
      type: "loop",
      name: loopName,
      fields: () => ({ type: "loop", name: loopName, steps: [] })
    },
    workflow: {
      type: "workflow",
      name: childName,
      fields: () => ({ type: "workflow", name: childName, workflow: "", input: {} })
    },
    notify: {
      type: "notify",
      name: notifyName,
      fields: () => ({
        type: "notify",
        name: notifyName,
        to: {},
        channels: ["inbox"],
        title: { value: "" },
        text: { value: "" }
      })
    }
  };
}

/** The palette as the picker's groups. A group with nothing in it is left out. */
export function paletteGroups(operations: readonly CallableOperationOption[], t: Translate) {
  const entry = (value: string, label: string, description: string): PickerOption => ({
    value,
    label,
    description
  });
  const offered = (operation: CallableOperationOption): PickerOption => {
    const words = operationWords(operation, t);
    const effect = t(
      operation.effect === "reading" ? "workflows.step.reading" : "workflows.step.changing"
    );
    return {
      value: `${OPERATION}${operation.name}`,
      label: operationName(operation, t),
      description:
        operation.name === MAIL
          ? t("workflows.palette.mailHint")
          : words.source === undefined
            ? effect
            : `${words.source} · ${effect}`,
      keywords: operation.name,
      ...(operation.available
        ? {}
        : { disabled: true, disabledReason: t("workflows.settings.operationUnavailable") })
    };
  };
  const mail = operations.filter((operation) => operation.name === MAIL).map(offered);
  const groups: PickerOptionGroup[] = [
    {
      heading: t("workflows.palette.data"),
      options: operations.filter((operation) => operation.name !== MAIL).map(offered)
    },
    {
      heading: t("workflows.palette.aiAndCode"),
      options: [
        entry("agent", t("workflows.palette.agent"), t("workflows.palette.agentHint")),
        entry("python", t("workflows.palette.python"), t("workflows.palette.scriptHint")),
        entry("javascript", t("workflows.palette.javascript"), t("workflows.palette.scriptHint"))
      ]
    },
    {
      heading: t("workflows.palette.flow"),
      options: [
        entry("loop", t("workflows.palette.loop"), t("workflows.palette.loopHint")),
        entry("workflow", t("workflows.palette.child"), t("workflows.palette.childHint"))
      ]
    },
    {
      heading: t("workflows.palette.people"),
      options: [
        entry("notify", t("workflows.palette.notify"), t("workflows.palette.notifyHint")),
        ...mail
      ]
    }
  ];
  return groups.filter((group) => group.options.length > 0);
}

/** The new step of a picked entry of the palette. */
export function newStepOf(
  value: string,
  operations: readonly CallableOperationOption[],
  t: Translate
): NewStep | undefined {
  if (value.startsWith(OPERATION)) {
    const operation = operations.find(
      (candidate) => candidate.name === value.slice(OPERATION.length)
    );
    if (operation === undefined) return undefined;
    const name = operationName(operation, t);
    return {
      name,
      fields: () => ({
        type: "operation",
        name,
        operation: operation.name,
        // A new mail goes out as the instance's own sender, the only one until MAIL-M365S.
        input: operation.name === MAIL ? { sender: { value: MAIL_SYSTEM_SENDER } } : {}
      })
    };
  }
  return plainEntries(t)[value];
}

/**
 * The palette around one "+": it opens on the point and gives the new step that was picked.
 * The operations are read once it opens.
 */
export function StepPalette({
  children,
  onPick
}: {
  /** The "+" that opens it. */
  children: ReactElement;
  onPick(step: NewStep): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const choices = useCallableOperations(open);
  const operations = choices.rows ?? [];
  const note = noteOf(choices, t);
  const label = t("workflows.palette.label");
  return (
    <Picker
      label={label}
      options={paletteGroups(operations, t)}
      value={undefined}
      search
      wrapDescriptions
      open={open}
      onOpenChange={setOpen}
      {...(note === undefined ? {} : { note })}
      onValueChange={(value) => {
        const picked = newStepOf(value, operations, t);
        if (picked !== undefined) onPick(picked);
      }}
    >
      {children}
    </Picker>
  );
}
