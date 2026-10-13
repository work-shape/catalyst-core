import { cn } from "../cn";
import { RegistryIcon } from "./registry-icon";

/** `sm` is 20 px and sits in a line of text, `md` is 28 px, `lg` is 32 px and leads a row. */
export type ConnectionIconSize = "sm" | "md" | "lg";

const connectionIconSizes: Record<ConnectionIconSize, string> = {
  sm: "size-5 rounded-sm [&_svg]:size-3",
  md: "size-7 rounded-md [&_svg]:size-4",
  lg: "size-8 rounded-md [&_svg]:size-4"
};

export interface ConnectionIconProps {
  /**
   * The key of the registry for the system behind the Connection, such as the Connection's
   * `service`. An application registers the icons of the systems it joins.
   */
  service?: string;
  /**
   * The key shown when nothing is registered under `service`: what kind of system it is,
   * such as `database`, `mail`, `files` or `web`. Without it the generic Connection icon shows.
   */
  category?: string;
  size?: ConnectionIconSize;
  className?: string;
}

/**
 * The icon of a Connection, on a rounded square tile as on the canvas. The tile is the mark of
 * a Connection: a skill's icon never sits on one. It repeats the name beside it, so it is
 * hidden from assistive technology.
 */
export function ConnectionIcon({ service, category, size = "md", className }: ConnectionIconProps) {
  return (
    <span
      aria-hidden="true"
      data-connection-icon={service ?? category ?? "generic"}
      className={cn(
        "inline-grid shrink-0 place-items-center bg-secondary text-muted-foreground",
        connectionIconSizes[size],
        className
      )}
    >
      <RegistryIcon name={service} fallback={category} family="service" />
    </span>
  );
}
