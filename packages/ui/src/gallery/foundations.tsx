import { Bell, Check, Search, Settings } from "lucide-react";
import { Button } from "../actions/button";
import { Input } from "../forms/input";
import { Select } from "../forms/select";
import { THEME_TOKEN_NAMES } from "../theme";
import { Samples, type GalleryGroup } from "./entry";

const colorTokens = THEME_TOKEN_NAMES.filter((name) => !name.startsWith("--shadow-"));

const typeStyles = [
  { name: "title-lg", className: "text-title-lg" },
  { name: "title", className: "text-title" },
  { name: "title-sm", className: "text-title-sm" },
  { name: "heading", className: "text-heading" },
  { name: "label", className: "text-label" },
  { name: "body", className: "text-body" },
  { name: "caption", className: "text-caption" },
  { name: "micro", className: "text-micro uppercase" },
  { name: "code", className: "font-mono text-code" }
] as const;

const radii = [
  { name: "sm", className: "rounded-sm" },
  { name: "md", className: "rounded-md" },
  { name: "lg", className: "rounded-lg" },
  { name: "xl", className: "rounded-xl" }
] as const;

const shadows = [
  { name: "raised", className: "shadow-raised" },
  { name: "overlay", className: "shadow-overlay" },
  { name: "modal", className: "shadow-modal" }
] as const;

const controlHeights = [
  { name: "sm", className: "h-control-sm" },
  { name: "md", className: "h-control-md" },
  { name: "lg", className: "h-control-lg" }
] as const;

function Caption({ children }: { children: string }) {
  return <span className="font-mono text-caption text-muted-foreground">{children}</span>;
}

export const foundationsGallery: GalleryGroup = {
  id: "foundations",
  entries: [
    {
      name: "colors",
      heading: (text) => text.colors,
      components: [],
      render: () => (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
          {colorTokens.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span
                className="size-8 shrink-0 rounded-md border"
                style={{ backgroundColor: `var(${name})` }}
              />
              <Caption>{name}</Caption>
            </div>
          ))}
        </div>
      )
    },
    {
      name: "type",
      heading: (text) => text.typeStyles,
      components: [],
      render: (text) => (
        <div className="grid gap-2">
          {typeStyles.map((style) => (
            <div key={style.name} className="grid grid-cols-[6rem_1fr] items-baseline gap-3">
              <Caption>{style.name}</Caption>
              <span className={style.className}>{text.typeSample}</span>
            </div>
          ))}
        </div>
      )
    },
    {
      name: "radius",
      heading: (text) => text.radius,
      components: [],
      render: () => (
        <Samples>
          {radii.map((radius) => (
            <div key={radius.name} className="grid justify-items-center gap-1">
              <span className={`size-16 border bg-card ${radius.className}`} />
              <Caption>{radius.name}</Caption>
            </div>
          ))}
        </Samples>
      )
    },
    {
      name: "shadows",
      heading: (text) => text.shadows,
      components: [],
      render: () => (
        <div className="flex flex-wrap gap-6 p-2">
          {shadows.map((shadow) => (
            <div key={shadow.name} className="grid justify-items-center gap-2">
              <span className={`h-16 w-24 rounded-lg border bg-popover ${shadow.className}`} />
              <Caption>{shadow.name}</Caption>
            </div>
          ))}
        </div>
      )
    },
    {
      name: "control-heights",
      heading: (text) => text.controlHeights,
      components: [],
      render: () => (
        <Samples>
          {controlHeights.map((height) => (
            <div key={height.name} className="flex items-center gap-2">
              <span className={`w-16 rounded-md border bg-card ${height.className}`} />
              <Caption>{height.name}</Caption>
            </div>
          ))}
        </Samples>
      )
    },
    {
      name: "icons",
      heading: (text) => text.icons,
      components: [],
      render: () => (
        <Samples>
          <Check aria-hidden="true" className="size-3" />
          <Search aria-hidden="true" className="size-4" />
          <Settings aria-hidden="true" className="size-4" />
          <Bell aria-hidden="true" className="size-5" />
        </Samples>
      )
    },
    {
      name: "focus",
      heading: (text) => text.focus,
      components: [],
      render: (text) => (
        <div className="grid gap-3">
          <p className="text-caption text-muted-foreground">{text.focusHint}</p>
          <Samples>
            <Button>{text.save}</Button>
            <Button variant="outline">{text.cancel}</Button>
            <Input className="w-48" aria-label={text.name} placeholder={text.namePlaceholder} />
            <Select className="w-48" aria-label={text.role}>
              <option>{text.roleMember}</option>
              <option>{text.roleAdmin}</option>
            </Select>
          </Samples>
        </div>
      )
    }
  ]
};
