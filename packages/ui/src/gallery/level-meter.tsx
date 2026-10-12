import { LevelMeter, type LevelMeterScale } from "../data/level-meter";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

function Levels({ scale, text }: { scale: LevelMeterScale; text: GalleryText }) {
  return (
    <div
      data-gallery-sample={`level-meter-${scale}`}
      className="grid w-full grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3"
    >
      {text.levelMeterLevels.map((word, index) => (
        <LevelMeter
          key={word}
          label={text.levelMeterLabel}
          level={index + 1}
          valueLabel={word}
          scale={scale}
        />
      ))}
    </div>
  );
}

export const levelMeterGalleryEntry: GalleryEntry = {
  name: "LevelMeter",
  components: ["LevelMeter"],
  render: (text) => (
    <>
      <Samples label={text.levelMeterSpectrum}>
        <Levels scale="spectrum" text={text} />
      </Samples>
      <Samples label={text.levelMeterTone}>
        <Levels scale="tone" text={text} />
      </Samples>
      <Samples label={text.levelMeterNeutral}>
        <Levels scale="neutral" text={text} />
      </Samples>
      <Samples label={text.levelMeterNarrow}>
        <LevelMeter
          className="w-40"
          label={text.levelMeterLabel}
          level={3}
          steps={4}
          valueLabel={text.levelMeterLevels[4]}
          scale="spectrum"
        />
      </Samples>
    </>
  )
};
