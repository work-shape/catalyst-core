import { useState } from "react";
import { Button } from "../actions/button";
import { TypedText } from "../data/typed-text";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

function TypedTextSample({ text }: { text: GalleryText }) {
  const [at, setAt] = useState(0);
  return (
    <div data-gallery-sample="typed-text" className="grid w-full max-w-md gap-3">
      <div className="flex items-center gap-3">
        <TypedText
          className="w-56 min-w-0 truncate text-body"
          text={text.typedTextTitles[at % text.typedTextTitles.length] ?? ""}
        />
        <Button variant="outline" size="sm" onClick={() => setAt(at + 1)}>
          {text.typedTextChange}
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">{text.typedTextNote}</p>
    </div>
  );
}

export const typedTextGalleryEntry: GalleryEntry = {
  name: "TypedText",
  components: ["TypedText"],
  render: (text) => (
    <Samples label={text.typedTextTitle}>
      <TypedTextSample text={text} />
    </Samples>
  )
};
