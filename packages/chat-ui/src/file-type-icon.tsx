import { cn, RegistryIcon } from "@vivd-catalyst/ui";
import type { FileType } from "./file-type";

/**
 * The icon of a file's type, from the icon registry. It repeats what the file name beside it
 * says, so it is hidden from screen readers. A place that shows no name has to name the file
 * itself. It is drawn 20 px wide unless `className` gives a size.
 */
export function FileTypeIcon({ type, className }: { type: FileType; className?: string }) {
  return <RegistryIcon name={type.icon} family="file" className={cn("size-5", className)} />;
}
