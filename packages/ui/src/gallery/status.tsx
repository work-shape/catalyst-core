import { Check } from "lucide-react";
import { Badge, type BadgeAppearance, type BadgeTone } from "../status/badge";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const badgeTones: readonly BadgeTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "accent"
];
const badgeAppearances: readonly BadgeAppearance[] = ["soft", "outline"];

function toneLabel(tone: BadgeTone, text: GalleryText): string {
  const labels: Record<BadgeTone, string> = {
    neutral: text.stateDraft,
    info: text.stateRunning,
    success: text.statePublished,
    warning: text.stateNeedsReconnect,
    danger: text.stateFailed,
    accent: text.stateNew
  };
  return labels[tone];
}

export const statusGallery: GalleryGroup = {
  id: "status",
  entries: [
    {
      name: "Badge",
      components: ["Badge"],
      render: (text) => (
        <>
          {badgeAppearances.map((appearance) => (
            <Samples key={appearance} label={appearance}>
              {badgeTones.map((tone) => (
                <Badge key={tone} tone={tone} appearance={appearance}>
                  {toneLabel(tone, text)}
                </Badge>
              ))}
            </Samples>
          ))}
          <Samples>
            {badgeTones.map((tone) => (
              <Badge key={tone} tone={tone} size="sm" dot>
                {toneLabel(tone, text)}
              </Badge>
            ))}
            <Badge tone="success">
              <Check aria-hidden="true" />
              {text.statePublished}
            </Badge>
          </Samples>
        </>
      )
    }
  ]
};
