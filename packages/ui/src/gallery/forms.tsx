import { Search } from "lucide-react";
import { Input, Textarea } from "../forms/input";
import { Select } from "../forms/select";
import { Switch } from "../forms/switch";
import { Samples, type GalleryGroup } from "./entry";

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
    }
  ]
};
