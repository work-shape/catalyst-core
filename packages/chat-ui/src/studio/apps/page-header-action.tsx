import type { ReactNode } from "react";
import { Button, IconButton } from "@work-shape/catalyst-ui";

/**
 * One action in the header of a Page. The header is narrow on a phone and in an App's frame
 * beside the dock: the action is its icon alone there, so the name keeps its room, and its
 * words everywhere else.
 */
export function PageHeaderAction({
  label,
  icon,
  onClick
}: {
  label: string;
  icon: ReactNode;
  onClick(): void;
}) {
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="max-md:hidden @max-3xl/app-frame:hidden"
        onClick={onClick}
      >
        {label}
      </Button>
      <IconButton
        label={label}
        variant="outline"
        size="sm"
        className="hidden max-md:inline-flex @max-3xl/app-frame:inline-flex"
        onClick={onClick}
      >
        {icon}
      </IconButton>
    </>
  );
}
