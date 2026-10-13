import type { ReactNode } from "react";
import { Button, IconButton } from "@vivd-catalyst/ui";

/**
 * One action in the header of a Page. The header is narrow on a phone: the action is its icon
 * alone there, and its words everywhere else.
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
      <Button variant="outline" size="sm" className="max-md:hidden" onClick={onClick}>
        {label}
      </Button>
      <IconButton label={label} variant="outline" size="sm" className="md:hidden" onClick={onClick}>
        {icon}
      </IconButton>
    </>
  );
}
