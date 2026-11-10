import { cn } from "../cn";
import { Avatar, type AvatarSize } from "./avatar";

export interface AvatarStackPerson {
  id: string;
  name: string;
}

export interface AvatarStackProps {
  people: readonly AvatarStackPerson[];
  /** How many avatars show before the rest are counted: "+2". */
  max?: number;
  size?: Extract<AvatarSize, "xs" | "sm">;
  className?: string;
}

const overlap: Record<NonNullable<AvatarStackProps["size"]>, string> = {
  xs: "-ml-1.5",
  sm: "-ml-2"
};

/**
 * The people who share something, as a short row of overlapping avatars and a count of the
 * rest. It shows who, not what they may do: the caller names the row, as a button that opens
 * the list does.
 */
export function AvatarStack({ people, max = 3, size = "sm", className }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center", className)}>
      {shown.map((person, index) => (
        <Avatar
          key={person.id}
          kind="person"
          name={person.name}
          size={size}
          className={cn("ring-2 ring-background", index > 0 && overlap[size])}
        />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            "inline-grid shrink-0 place-items-center rounded-full bg-muted text-micro font-semibold text-muted-foreground ring-2 ring-background",
            size === "xs" ? "size-5" : "size-6",
            overlap[size]
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
