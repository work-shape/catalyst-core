import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, Textarea } from "@work-shape/catalyst-ui";
import { useTranslation } from "../shared/i18n";

/**
 * "New" of a kind no person writes by hand, such as Apps, Workflows and Data Stores: one
 * question, what the new one should do, and "Build with the agent", which opens the dock with
 * the kind's started sentence and the answer in its composer. The chat opens only on that click.
 */
export function BuildWithAgentDialog({
  title,
  prompt,
  onBuild,
  onClose
}: {
  /** The kind's New, such as "New data store". */
  title: string;
  /** The kind's started sentence, such as "Build a new data store that holds ". */
  prompt: string;
  /** Opens the agent with this text in its composer. */
  onBuild(prompt: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [purpose, setPurpose] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onClose();
    onBuild(`${prompt}${purpose.trim()}`);
  };
  return (
    <Dialog
      open
      size="sm"
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="build-with-agent-form">
            {t("build.briefBuild")}
          </Button>
        </>
      }
    >
      <form id="build-with-agent-form" className="grid gap-3" onSubmit={submit}>
        <Field label={t("build.briefLabel")} hint={t("build.briefHint")}>
          <Textarea
            autoFocus
            rows={3}
            value={purpose}
            data-build-with-agent-brief=""
            onChange={(event) => setPurpose(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
