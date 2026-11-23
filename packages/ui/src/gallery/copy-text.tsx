import { CopyText } from "../data/copy-text";
import { Samples, type GalleryEntry } from "./entry";

export const copyTextGalleryEntry: GalleryEntry = {
  name: "CopyText",
  components: ["CopyText"],
  render: (text) => (
    <div className="grid items-start gap-6 sm:grid-cols-2">
      <Samples label={text.copyTextLabelled}>
        <CopyText className="w-full" label={text.copyTextLabel} text={text.copyTextMessage} />
      </Samples>
      <Samples label={text.copyTextPlain}>
        <CopyText className="w-full" text={text.copyTextShort} />
      </Samples>
      <Samples label={text.copyTextNarrow}>
        <CopyText className="w-56" label={text.copyTextLabel} text={text.copyTextLong} />
      </Samples>
      <Samples label={text.copyTextPending}>
        <CopyText
          className="w-full"
          label={text.copyTextLabel}
          text={text.copyTextMessage.slice(0, 60)}
          pending
        />
      </Samples>
    </div>
  )
};
