import { editingFormsEntries } from "./editing-forms";
import { mailFormEntries } from "./mail";
import { Search, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { Checkbox } from "../forms/checkbox";
import { ChipInput } from "../forms/chip-input";
import { ComposerFrame } from "../forms/composer-frame";
import { Field } from "../forms/field";
import { Input, Textarea } from "../forms/input";
import { NameWithAddress, addressOf, type NameAndAddress } from "../forms/name-with-address";
import { ProposedValue } from "../forms/proposed-value";
import { RadioGroup } from "../forms/radio-group";
import { RenameField } from "../forms/rename-field";
import { SaveBar } from "../forms/save-bar";
import { Select } from "../forms/select";
import { Switch } from "../forms/switch";
import { Page } from "../structure/page";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const rowAgents = ["rowAgent", "rowWorkflow", "rowKnowledge"] as const;

/** A list of short values as chips: empty, filled, wrong and disabled. */
function ChipInputSamples({ text }: { text: GalleryText }) {
  const [empty, setEmpty] = useState<readonly string[]>([]);
  const [filled, setFilled] = useState<readonly string[]>(["10101", "10102", "20417"]);
  return (
    <div className="grid w-full max-w-sm gap-6">
      <Field label={text.chipValues} hint={text.chipValuesHint}>
        <ChipInput value={empty} onChange={setEmpty} placeholder={text.chipValuesPlaceholder} />
      </Field>
      <Field label={text.chipValues} hint={text.chipValuesHint}>
        <ChipInput value={filled} onChange={setFilled} />
      </Field>
      <Field label={text.chipValues} error={text.chipValuesError}>
        <ChipInput value={[]} onChange={() => undefined} />
      </Field>
      <Field label={text.chipValues}>
        <ChipInput value={["10101"]} onChange={() => undefined} disabled />
      </Field>
    </div>
  );
}

/** A select-all box over three rows: it is indeterminate while only some rows are checked. */
function SelectAllSample({ text }: { text: GalleryText }) {
  const [selected, setSelected] = useState<readonly string[]>(["rowAgent"]);
  const all = selected.length === rowAgents.length;
  return (
    <div className="grid gap-2">
      <Checkbox
        label={text.selectAll}
        checked={all ? true : selected.length > 0 ? "indeterminate" : false}
        onCheckedChange={(checked) => setSelected(checked ? rowAgents : [])}
      />
      <div className="grid gap-2 pl-6">
        {rowAgents.map((row) => (
          <Checkbox
            key={row}
            label={text[row]}
            checked={selected.includes(row)}
            onCheckedChange={(checked) =>
              setSelected(checked ? [...selected, row] : selected.filter((entry) => entry !== row))
            }
          />
        ))}
      </div>
    </div>
  );
}

const INSTRUCTIONS_LIMIT = 200;

function FieldSamples({ text }: { text: GalleryText }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState(text.instructionsSample);
  const tooShort = name.trim().length > 0 && name.trim().length < 3;
  return (
    <div className="grid max-w-sm gap-5">
      <Field
        label={text.name}
        hint={text.nameHint}
        error={tooShort ? text.nameError : undefined}
        required
      >
        <Input
          value={name}
          placeholder={text.namePlaceholder}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label={text.name} error={text.nameError}>
        <Input defaultValue="AB" />
      </Field>
      <Field label={text.role} optional>
        <Select>
          <option>{text.roleMember}</option>
          <option>{text.roleAdmin}</option>
        </Select>
      </Field>
      <Field label={text.description} hint={text.nameHint} optional>
        <Textarea defaultValue={text.cardBody} />
      </Field>
      <Field label={text.name} hint={text.nameHint}>
        <Input defaultValue={text.namePlaceholder} disabled />
      </Field>
      <Field label={text.instructions} labelEnd={`${instructions.length} / ${INSTRUCTIONS_LIMIT}`}>
        <Textarea
          value={instructions}
          maxLength={INSTRUCTIONS_LIMIT}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      <Field layout="inline" label={text.liveChanges} hint={text.liveChangesHint}>
        <Switch />
      </Field>
      <Field layout="inline" label={text.notifyByEmail} hint={text.notifyByEmailHint}>
        <Checkbox defaultChecked />
      </Field>
    </div>
  );
}

/** The address follows the name until it is typed; one address counts as taken. */
function NameWithAddressSample({ text }: { text: GalleryText }) {
  const [value, setValue] = useState<NameAndAddress>({ name: "" });
  const address = addressOf(value, slug);
  return (
    <div className="grid max-w-sm" data-gallery-sample="name-with-address">
      <NameWithAddress
        value={value}
        onChange={setValue}
        derive={slug}
        check={
          address === ""
            ? { state: "unchecked" }
            : address === slug(text.namePlaceholder)
              ? { state: "refused", reason: text.addressTaken }
              : { state: "free" }
        }
        nameLabel={text.name}
        addressLabel={text.address}
        addressHint={text.addressHint}
        advancedLabel={text.advanced}
      />
    </div>
  );
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

/** A name renamed where it stands: the field replaces it until Enter, leaving or Escape. */
function RenameFieldSample({ text }: { text: GalleryText }) {
  const [name, setName] = useState(text.namePlaceholder);
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="flex w-full max-w-sm items-center gap-3" data-gallery-sample="rename-field">
      {renaming ? (
        <RenameField
          className="flex-1"
          size="title-sm"
          value={name}
          label={text.renameField}
          maxLength={120}
          onSave={(next) => {
            setName(next);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <>
          <span className="min-w-0 flex-1 text-title-sm">{name}</span>
          <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
            {text.rename}
          </Button>
        </>
      )}
    </div>
  );
}

/** The bar is absent until a field differs from what was saved, then counts the changes. */
function SaveBarWhenCleanSample({ text }: { text: GalleryText }) {
  const saved = { name: text.namePlaceholder, description: text.cardBody };
  const [name, setName] = useState(saved.name);
  const [description, setDescription] = useState(saved.description);
  const changed = Number(name !== saved.name) + Number(description !== saved.description);
  const discard = () => {
    setName(saved.name);
    setDescription(saved.description);
  };
  return (
    <div className="grid w-full max-w-sm gap-3" data-gallery-sample="save-bar-when-clean">
      <Input
        aria-label={text.name}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label={text.description}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <SaveBar
        label={text.saveChanges}
        whenClean="hidden"
        dirty={changed > 0}
        changes={changed === 1 ? text.saveOneChange : text.saveTwoChanges}
        discardLabel={text.saveDiscard}
        onDiscard={discard}
        onSave={discard}
      />
    </div>
  );
}

function SaveBarSamples({ text }: { text: GalleryText }) {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Samples label={text.saveInline}>
        <div className="grid w-full">
          <SaveBar
            label={text.saveChanges}
            hint={text.saveHint}
            saved={saved}
            savedLabel={text.saveSaved}
            onSave={() => setSaved((value) => !value)}
          />
          <SaveBar label={text.saveChanges} saved savedLabel={text.saveSaved} onSave={noop} />
          <SaveBar label={text.saveChanges} hint={text.saveHint} saving onSave={noop} />
          <SaveBar label={text.saveChanges} hint={text.saveHint} disabled onSave={noop} />
        </div>
      </Samples>
      <Samples label={text.saveSticky}>
        <div
          className="h-56 w-full overflow-y-auto rounded-lg border"
          data-gallery-sample="save-bar-sticky"
        >
          <Page width="narrow">
            <p className="text-body text-muted-foreground">{text.saveStickyBody}</p>
            <Textarea
              className="mt-4 min-h-64"
              aria-label={text.instructions}
              defaultValue={text.instructionsSample}
            />
          </Page>
          <SaveBar
            mode="sticky"
            label={text.saveChanges}
            hint={text.saveHint}
            secondaryAction={<Button variant="ghost">{text.saveDiscard}</Button>}
            onSave={noop}
          />
        </div>
      </Samples>
      <Samples label={text.saveWhenClean}>
        <SaveBarWhenCleanSample text={text} />
      </Samples>
    </>
  );
}

function noop(): void {
  // The static samples save nothing.
}

export const formsGallery: GalleryGroup = {
  id: "forms",
  entries: [
    ...editingFormsEntries,
    ...mailFormEntries,
    {
      name: "Input",
      components: ["Input"],
      render: (text) => (
        <div className="grid max-w-sm gap-3">
          <Input aria-label={text.name} placeholder={text.namePlaceholder} />
          <Input aria-label={text.name} defaultValue={text.namePlaceholder} />
          <Input
            size="sm"
            type="search"
            aria-label={text.searchPlaceholder}
            placeholder={text.searchPlaceholder}
            leadingIcon={<Search aria-hidden="true" />}
          />
          <Input aria-label={text.name} defaultValue={text.invalidValue} invalid />
          <Input aria-label={text.name} placeholder={text.disabled} disabled />
        </div>
      )
    },
    {
      name: "Textarea",
      components: ["Textarea"],
      render: (text) => (
        <div className="grid max-w-sm gap-3">
          <Textarea aria-label={text.instructions} defaultValue={text.instructionsSample} />
          <Textarea aria-label={text.instructions} variant="code" defaultValue={text.codeSample} />
          <Textarea aria-label={text.instructions} defaultValue={text.invalidValue} invalid />
        </div>
      )
    },
    {
      name: "ComposerFrame",
      components: ["ComposerFrame"],
      render: (text) => (
        <div className="grid max-w-md gap-2">
          <ComposerFrame variant="tray" className="grid gap-1">
            <span className="px-2 text-label">{text.composerQueued}</span>
            <span className="px-2 pb-1 text-body text-muted-foreground">
              {text.composerQueuedMessage}
            </span>
          </ComposerFrame>
          <ComposerFrame className="flex items-end gap-1">
            <Textarea aria-label={text.composerMessage} variant="composer" className="flex-1" />
            <Button variant="solid" size="icon" aria-label={text.send}>
              <Send aria-hidden="true" />
            </Button>
          </ComposerFrame>
        </div>
      )
    },
    {
      name: "Select",
      components: ["Select"],
      render: (text) => (
        <div className="grid max-w-sm gap-3">
          <Select aria-label={text.role}>
            <option>{text.roleMember}</option>
            <option>{text.roleAdmin}</option>
          </Select>
          <Select size="sm" aria-label={text.role}>
            <option>{text.roleMember}</option>
            <option>{text.roleAdmin}</option>
          </Select>
          <Select aria-label={text.role} invalid>
            <option>{text.roleMember}</option>
          </Select>
          <Select aria-label={text.role} disabled>
            <option>{text.disabled}</option>
          </Select>
        </div>
      )
    },
    {
      name: "Checkbox",
      components: ["Checkbox"],
      render: (text) => (
        <>
          <Samples>
            <Checkbox aria-label={text.enabled} />
            <Checkbox aria-label={text.enabled} defaultChecked />
            <Checkbox aria-label={text.enabled} checked="indeterminate" />
            <Checkbox aria-label={text.disabled} disabled />
            <Checkbox aria-label={text.disabled} defaultChecked disabled />
            <Checkbox aria-label={text.invalidValue} invalid />
          </Samples>
          <div className="grid max-w-sm gap-3">
            <Checkbox label={text.notifyByEmail} description={text.notifyByEmailHint} />
            <Checkbox label={text.acceptTerms} invalid required />
            <Checkbox label={text.disabled} description={text.notifyByEmailHint} disabled />
          </div>
          <SelectAllSample text={text} />
        </>
      )
    },
    {
      name: "RadioGroup",
      components: ["RadioGroup"],
      render: (text) => (
        <div className="grid max-w-sm gap-6">
          <RadioGroup
            label={text.visibility}
            hint={text.visibilityHelp}
            defaultValue="discoverable"
            options={[
              {
                value: "discoverable",
                label: text.visibilityDiscoverable,
                description: text.visibilityDiscoverableHint
              },
              {
                value: "private",
                label: text.visibilityPrivate,
                description: text.visibilityPrivateHint
              },
              {
                value: "archived",
                label: text.visibilityArchived,
                description: text.visibilityArchivedHint,
                disabled: true
              }
            ]}
          />
          <section className="grid gap-2" aria-label={text.availability}>
            <h3 className="text-title-sm">{text.availability}</h3>
            <RadioGroup
              variant="plain"
              label={text.availability}
              labelHidden
              defaultValue="all"
              options={[
                { value: "all", label: text.availabilityAll },
                { value: "selected", label: text.availabilitySelected }
              ]}
            />
          </section>
          <RadioGroup
            variant="plain"
            label={text.disabled}
            defaultValue="all"
            disabled
            options={[
              { value: "all", label: text.availabilityAll },
              { value: "selected", label: text.availabilitySelected }
            ]}
          />
        </div>
      )
    },
    {
      name: "Switch",
      components: ["Switch"],
      render: (text) => (
        <Samples>
          <Switch aria-label={text.enabled} />
          <Switch aria-label={text.enabled} defaultChecked />
          <Switch aria-label={text.disabled} disabled />
          <Switch aria-label={text.disabled} defaultChecked disabled />
          <Switch aria-label={text.switchMixed} mixed />
        </Samples>
      )
    },
    {
      name: "ChipInput",
      components: ["ChipInput"],
      render: (text) => <ChipInputSamples text={text} />
    },
    {
      name: "Field",
      components: ["Field"],
      render: (text) => <FieldSamples text={text} />
    },
    {
      name: "ProposedValue",
      components: ["ProposedValue"],
      render: (text) => (
        <div className="grid max-w-sm gap-2">
          <Field label={text.instructions}>
            <Textarea readOnly defaultValue={text.instructionsSample} />
          </Field>
          <ProposedValue label={text.proposedLabel}>{text.proposedSample}</ProposedValue>
        </div>
      )
    },
    {
      name: "NameWithAddress",
      components: ["NameWithAddress"],
      render: (text) => <NameWithAddressSample text={text} />
    },
    {
      name: "RenameField",
      components: ["RenameField"],
      render: (text) => <RenameFieldSample text={text} />
    },
    {
      name: "SaveBar",
      components: ["SaveBar"],
      render: (text) => <SaveBarSamples text={text} />
    }
  ]
};
