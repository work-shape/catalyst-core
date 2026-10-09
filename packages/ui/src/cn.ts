import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** A class name, a list of them, or a map from class name to whether it applies. */
export type ClassInput =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | ClassInput[]
  | { [className: string]: unknown };

// The library's own type styles, control heights and shadows, so a caller's `text-xs`, `h-8`
// or `shadow-none` replaces them the way it replaces a built-in utility.
const mergeClasses = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "title-lg",
        "title",
        "title-sm",
        "heading",
        "label",
        "body",
        "caption",
        "micro",
        "code"
      ],
      spacing: ["control-sm", "control-md", "control-lg"],
      shadow: ["raised", "overlay", "modal"]
    }
  }
});

export function cn(...inputs: ClassInput[]): string {
  return mergeClasses(clsx(inputs));
}
