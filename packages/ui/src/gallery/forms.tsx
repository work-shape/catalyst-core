import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { Checkbox } from "../forms/checkbox";
import { Field } from "../forms/field";
import { Input, Textarea } from "../forms/input";
import { RadioGroup } from "../forms/radio-group";
import { SaveBar } from "../forms/save-bar";
import { Select } from "../forms/select";
import { Switch } from "../forms/switch";
import { Page } from "../structure/page";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const rowAgents = ["rowAgent", "rowWorkflow", "rowKnowledge"] as const;

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

function FieldSamples({ text }: { text: GalleryText }) {
  const [name, setName] = useState("");
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
      <Field layout="inline" label={text.liveChanges} hint={text.liveChangesHint}>
        <Switch />
      </Field>
      <Field layout="inline" label={text.notifyByEmail} hint={text.notifyByEmailHint}>
        <Checkbox defaultChecked />
      </Field>
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
          className="h-56 w-full overflow-y-auto rounded-lg border [scrollbar-width:thin]"
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
    </>
  );
}

function noop(): void {
  // The static samples save nothing.
}

export const formsGallery: GalleryGroup = {
  id: "forms",
  entries: [
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
          <RadioGroup
            variant="plain"
            label={text.availability}
            defaultValue="all"
            options={[
              { value: "all", label: text.availabilityAll },
              { value: "selected", label: text.availabilitySelected }
            ]}
          />
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
        </Samples>
      )
    },
    {
      name: "Field",
      components: ["Field"],
      render: (text) => <FieldSamples text={text} />
    },
    {
      name: "SaveBar",
      components: ["SaveBar"],
      render: (text) => <SaveBarSamples text={text} />
    }
  ]
};
