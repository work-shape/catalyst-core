import { Ellipsis, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "../actions/button";
import { IconButton, type IconButtonSize } from "../actions/icon-button";
import { RunLiveOnce, type RunLiveOnceState } from "../actions/run-live-once";
import { TextLink } from "../actions/text-link";
import { Starter, StarterList } from "../actions/starter";
import { SkillIcon } from "../status/skill-icon";
import { TargetBadge } from "../status/target-badge";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const liveOnceStates: readonly RunLiveOnceState[] = ["off", "busy", "on"];

/** A switch beside the marker it changes: it is set after a moment, as an instance answers. */
function LiveOnceSample({ text }: { text: GalleryText }) {
  const [state, setState] = useState<RunLiveOnceState>("off");
  return (
    <Samples label="interactive">
      <TargetBadge target={state === "on" ? "live" : "dry_run"} />
      <RunLiveOnce
        state={state}
        onText={text.liveOnceOn}
        onSwitchOn={() => {
          setState("busy");
          setTimeout(() => setState("on"), 600);
        }}
      />
      {state === "on" ? (
        <Button variant="ghost" size="sm" onClick={() => setState("off")}>
          {text.showAgain}
        </Button>
      ) : null}
    </Samples>
  );
}

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
    },
    {
      name: "TextLink",
      components: ["TextLink"],
      render: (text) => (
        <Samples>
          <p className="text-body text-muted-foreground">
            <TextLink href="#" onClick={(event) => event.preventDefault()}>
              {text.learnMore}
            </TextLink>
            {" · "}
            {text.disabled}
          </p>
          <p className="text-caption text-muted-foreground">
            <TextLink href="#" onClick={(event) => event.preventDefault()}>
              {text.learnMore}
            </TextLink>
          </p>
        </Samples>
      )
    },
    {
      name: "Starter",
      components: ["Starter", "StarterList"],
      render: (text) => (
        <div className="max-w-2xl" data-gallery-sample="starters">
          <StarterList label={text.starterListLabel}>
            <Starter
              icon={<SkillIcon icon="spreadsheet" size="lg" />}
              title={text.starterSheet}
              hint={text.starterSheetHint}
            />
            <Starter
              icon={<SkillIcon icon="document" size="lg" />}
              title={text.starterLetter}
              hint={text.starterLetterHint}
            />
            <Starter
              icon={<SkillIcon icon="guide" size="lg" />}
              title={text.starterGuide}
              hint={text.starterGuideHint}
            />
            <Starter icon={<SkillIcon size="lg" />} title={text.starterPlain} />
            <Starter
              icon={<SkillIcon icon="pdf" size="lg" />}
              title={text.starterPdf}
              hint={text.starterPdfHint}
              disabled
            />
          </StarterList>
        </div>
      )
    },
    {
      name: "RunLiveOnce",
      components: ["RunLiveOnce"],
      render: (text) => (
        <>
          <Samples>
            {liveOnceStates.map((state) => (
              <RunLiveOnce
                key={state}
                state={state}
                onText={text.liveOnceOn}
                onSwitchOn={() => undefined}
              />
            ))}
          </Samples>
          <LiveOnceSample text={text} />
        </>
      )
    }
  ]
};
