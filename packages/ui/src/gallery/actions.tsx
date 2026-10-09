import { Ellipsis, Plus, Settings } from "lucide-react";
import { Button, type ButtonSize, type ButtonVariant } from "../actions/button";
import { IconButton, type IconButtonSize } from "../actions/icon-button";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const buttonVariants: readonly ButtonVariant[] = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "danger",
  "link"
];
const buttonSizes: readonly ButtonSize[] = ["sm", "md", "lg"];
const iconButtonSizes: readonly IconButtonSize[] = ["sm", "md", "lg"];

function buttonLabel(variant: ButtonVariant, text: GalleryText): string {
  if (variant === "danger") {
    return text.delete;
  }
  if (variant === "link") {
    return text.learnMore;
  }
  return variant === "primary" ? text.save : text.cancel;
}

export const actionsGallery: GalleryGroup = {
  id: "actions",
  entries: [
    {
      name: "Button",
      components: ["Button"],
      render: (text) => (
        <>
          <Samples>
            {buttonVariants.map((variant) => (
              <Button key={variant} variant={variant}>
                {buttonLabel(variant, text)}
              </Button>
            ))}
          </Samples>
          <Samples>
            {buttonSizes.map((size) => (
              <Button key={size} size={size}>
                <Plus aria-hidden="true" />
                {text.addItem}
              </Button>
            ))}
          </Samples>
          <Samples>
            <Button loading>{text.saving}</Button>
            <Button variant="outline" loading>
              {text.publish}
            </Button>
            <Button disabled>{text.disabled}</Button>
            <Button variant="outline" disabled>
              {text.disabled}
            </Button>
          </Samples>
        </>
      )
    },
    {
      name: "IconButton",
      components: ["IconButton"],
      render: (text) => (
        <>
          <Samples>
            {iconButtonSizes.map((size) => (
              <IconButton key={size} size={size} label={text.settings}>
                <Settings aria-hidden="true" />
              </IconButton>
            ))}
            {iconButtonSizes.map((size) => (
              <IconButton key={size} size={size} variant="outline" label={text.moreActions}>
                <Ellipsis aria-hidden="true" />
              </IconButton>
            ))}
            <IconButton label={text.disabled} disabled>
              <Settings aria-hidden="true" />
            </IconButton>
          </Samples>
        </>
      )
    }
  ]
};
