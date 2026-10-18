import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  FormNotice,
  InlineError,
  Input,
  KeyValue,
  KeyValueList,
  Picker,
  PickerButton,
  RadioGroup,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  PersonContextConflictError,
  type ConnectionSource,
  type PersonContextRead,
  type PersonContextSubject
} from "./connection-source";
import { instanceSentence } from "./build-refusals";

// The person context mappings of a REST API Connection: which value each call sends in the
// Connection's person context header, per person or service principal. Nobody is mapped by
// default, and a call for someone without a mapping is refused. The values are admin data:
// the page reads one mapping at a time, for one subject the admin chooses by name.

type Mappings = NonNullable<ConnectionSource["personContext"]>;
type SubjectKind = PersonContextSubject["kind"];

/** The longest value the instance accepts. */
const VALUE_MAX_LENGTH = 1024;

/** From this many people or principals on, the picker offers a search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

/** Choose a person or service principal by name, then read and change their one mapping. */
export function PersonContextSection({
  name,
  header,
  mappings
}: {
  name: string;
  /** The header the Connection sends the mapped value in. */
  header: string;
  mappings: Mappings;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SubjectKind>("user");
  const [subject, setSubject] = useState<PersonContextSubject>();
  return (
    <div className="grid gap-4" role="group" data-connection-person-context="">
      <KeyValueList>
        <KeyValue label={t("connections.personContextHeader")}>
          <code className="font-mono text-code">{header}</code>
        </KeyValue>
      </KeyValueList>
      <p className="text-body">{t("connections.personContextExplain")}</p>
      <RadioGroup<SubjectKind>
        label={t("connections.personContextKind")}
        variant="plain"
        value={kind}
        onValueChange={(next) => {
          setKind(next);
          setSubject(undefined);
        }}
        options={[
          { value: "user", label: t("connections.personContextKindUser") },
          { value: "service_principal", label: t("connections.accessServicePrincipal") }
        ]}
      />
      {/* A new kind starts the chooser over: its list and its typed id belong to the kind. */}
      <SubjectChooser
        key={kind}
        kind={kind}
        mappings={mappings}
        subject={subject}
        onSubjectChange={setSubject}
      />
      {subject ? (
        <PersonContextMapping
          key={JSON.stringify([name, header, subject.kind, subject.id])}
          name={name}
          header={header}
          subject={subject}
          mappings={mappings}
        />
      ) : null}
    </div>
  );
}

/**
 * The person or principal to map, chosen by name from the instance's list. A reader who may not
 * list them is told so, and may type a technical id behind a disclosure.
 */
function SubjectChooser({
  kind,
  mappings,
  subject,
  onSubjectChange
}: {
  kind: SubjectKind;
  mappings: Mappings;
  subject: PersonContextSubject | undefined;
  onSubjectChange(subject: PersonContextSubject | undefined): void;
}) {
  const { t } = useTranslation();
  const subjects = mappings.useSubjects(kind);
  const label = t(
    kind === "user" ? "connections.personContextKindUser" : "connections.accessServicePrincipal"
  );

  if (subjects.status === "loading") {
    return <SkeletonList rows={1} />;
  }
  if (subjects.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("connections.personContextListFailed")}</span>
        <Button variant="outline" size="sm" onClick={subjects.retry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  if (subjects.status === "hidden") {
    return (
      <div className="grid gap-2" data-person-context-list="hidden">
        <Banner tone="info">
          {t(
            kind === "user"
              ? "connections.personContextPeopleHidden"
              : "connections.personContextPrincipalsHidden"
          )}
        </Banner>
        <Disclosure>
          <DisclosureTrigger>{t("connections.personContextEnterId")}</DisclosureTrigger>
          <DisclosureContent>
            <SubjectIdForm kind={kind} onSubjectChange={onSubjectChange} />
          </DisclosureContent>
        </Disclosure>
      </div>
    );
  }
  if (subjects.subjects.length === 0) {
    return (
      <p className="text-body text-muted-foreground" data-person-context-list="empty">
        {t(
          kind === "user"
            ? "connections.personContextNoPeople"
            : "connections.personContextNoPrincipals"
        )}
      </p>
    );
  }
  const chosen = subjects.subjects.find((option) => option.id === subject?.id);
  return (
    <Field label={label} className="max-w-md">
      <Picker
        label={label}
        search={subjects.subjects.length >= PICKER_SEARCH_FROM_COUNT}
        options={subjects.subjects.map((option) => ({
          value: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          keywords: option.id
        }))}
        value={chosen?.id}
        onValueChange={(id) => onSubjectChange({ kind, id })}
      >
        <PickerButton
          label={label}
          placeholder={t(
            kind === "user"
              ? "connections.personContextChoosePerson"
              : "connections.personContextChoosePrincipal"
          )}
          value={chosen?.label}
          data-connection-field="personContextSubject"
        />
      </Picker>
    </Field>
  );
}

/** The technical id of a person or principal, for a reader who may not list them. */
function SubjectIdForm({
  kind,
  onSubjectChange
}: {
  kind: SubjectKind;
  onSubjectChange(subject: PersonContextSubject | undefined): void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  return (
    <form
      className="grid gap-3 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        const subjectId = id.trim();
        if (subjectId !== "") onSubjectChange({ kind, id: subjectId });
      }}
    >
      <Field
        label={t("connections.personContextSubjectId")}
        hint={t("connections.personContextSubjectIdHint")}
      >
        <Input
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          value={id}
          data-connection-field="personContextSubjectId"
          onChange={(event) => {
            setId(event.target.value);
            onSubjectChange(undefined);
          }}
        />
      </Field>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="justify-self-start"
        disabled={id.trim() === ""}
      >
        {t("connections.personContextShow")}
      </Button>
    </form>
  );
}

/** What the last write of a mapping left to say. */
type WriteFailure = { kind: "conflict" } | { kind: "failed"; message: string | undefined };

/** The mapping of one subject: whether there is one, and its value to change or remove. */
function PersonContextMapping({
  name,
  header,
  subject,
  mappings
}: {
  name: string;
  header: string;
  subject: PersonContextSubject;
  mappings: Mappings;
}) {
  const { t } = useTranslation();
  const read = mappings.useMapping(name, subject);
  const [saving, setSaving] = useState<"save" | "remove">();
  const [failure, setFailure] = useState<WriteFailure>();

  if (read.status === "loading") {
    return <SkeletonList rows={2} />;
  }
  if (read.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{read.message ?? t("connections.personContextReadFailed")}</span>
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }

  const write = async (action: "save" | "remove", value: string | null) => {
    setSaving(action);
    setFailure(undefined);
    try {
      await mappings.setMapping(name, subject, value, read.rowVersion);
    } catch (error) {
      setFailure(
        error instanceof PersonContextConflictError
          ? { kind: "conflict" }
          : { kind: "failed", message: instanceSentence(error) }
      );
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <div
      className="grid gap-3"
      role="group"
      data-person-context-mapping={read.value ? "mapped" : "unmapped"}
    >
      <div className="grid justify-items-start gap-1.5">
        <Badge tone={read.value ? "success" : "warning"} dot>
          {t(read.value ? "connections.personContextMapped" : "connections.personContextUnmapped")}
        </Badge>
        {read.value ? null : (
          <p className="text-body">{t("connections.personContextUnmappedText")}</p>
        )}
      </div>
      {/* A new row version starts the field over from the stored value. */}
      <PersonContextValueForm
        key={read.rowVersion ?? "none"}
        header={header}
        read={read}
        saving={saving}
        onSave={(value) => {
          write("save", value).catch(() => undefined);
        }}
        onRemove={() => {
          write("remove", null).catch(() => undefined);
        }}
      />
      {failure?.kind === "conflict" ? (
        <FormNotice tone="error">{t("connections.personContextConflict")}</FormNotice>
      ) : failure ? (
        <FormNotice tone="error">
          {failure.message ?? t("connections.personContextWriteFailed")}
        </FormNotice>
      ) : null}
    </div>
  );
}

function PersonContextValueForm({
  header,
  read,
  saving,
  onSave,
  onRemove
}: {
  header: string;
  read: Extract<PersonContextRead, { status: "ready" }>;
  saving: "save" | "remove" | undefined;
  onSave(value: string): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(read.value ?? "");
  const trimmed = value.trim();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "" && trimmed !== read.value) onSave(trimmed);
      }}
    >
      <Field
        label={t("connections.personContextValue", { header })}
        hint={t("connections.personContextValueHint")}
      >
        <Input
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          maxLength={VALUE_MAX_LENGTH}
          value={value}
          disabled={saving !== undefined}
          data-connection-field="personContextValue"
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={saving === "save"}
          disabled={trimmed === "" || trimmed === read.value || saving !== undefined}
        >
          {t("connections.personContextSave")}
        </Button>
        {read.value ? (
          <Button
            variant="outline"
            size="sm"
            loading={saving === "remove"}
            disabled={saving !== undefined}
            onClick={onRemove}
          >
            {t("connections.personContextRemove")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
