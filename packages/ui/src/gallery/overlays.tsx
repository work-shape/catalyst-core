import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { Dialog, type DialogSize } from "../overlays/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../overlays/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const dialogSizes: readonly DialogSize[] = ["sm", "md", "lg"];

function DialogSamples({ text }: { text: GalleryText }) {
  const [openSize, setOpenSize] = useState<DialogSize | undefined>(undefined);
  const close = () => setOpenSize(undefined);
  return (
    <Samples>
      {dialogSizes.map((size) => (
        <Button key={size} variant="outline" onClick={() => setOpenSize(size)}>
          {text.openDialog} {size}
        </Button>
      ))}
      <Dialog
        open={openSize !== undefined}
        size={openSize}
        title={text.dialogTitle}
        description={text.dialogDescription}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              {text.cancel}
            </Button>
            <Button variant="danger" onClick={close}>
              {text.delete}
            </Button>
          </>
        }
        onClose={close}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-body">{text.dialogBody}</p>
          <IconButton variant="outline" label={text.tooltipText}>
            <Copy aria-hidden="true" />
          </IconButton>
        </div>
      </Dialog>
    </Samples>
  );
}

export const overlaysGallery: GalleryGroup = {
  id: "overlays",
  entries: [
    {
      name: "Dialog",
      components: ["Dialog"],
      render: (text) => <DialogSamples text={text} />
    },
    {
      name: "Tooltip",
      components: ["Tooltip", "TooltipTrigger", "TooltipContent"],
      render: (text) => (
        <Samples>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">{text.tooltipText}</Button>
            </TooltipTrigger>
            <TooltipContent shortcut="⌘C">{text.tooltipText}</TooltipContent>
          </Tooltip>
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button variant="ghost">{text.learnMore}</Button>
            </TooltipTrigger>
            <TooltipContent side="right">{text.tooltipText}</TooltipContent>
          </Tooltip>
        </Samples>
      )
    },
    {
      name: "HoverCard",
      components: ["HoverCard", "HoverCardTrigger", "HoverCardContent"],
      render: (text) => (
        <Samples>
          <HoverCard openDelay={100}>
            <HoverCardTrigger asChild>
              <Button variant="outline">{text.hoverCardTrigger}</Button>
            </HoverCardTrigger>
            <HoverCardContent align="start">
              <p className="text-body">{text.hoverCardBody}</p>
            </HoverCardContent>
          </HoverCard>
        </Samples>
      )
    }
  ]
};
