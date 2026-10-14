import { cn } from "../cn";
import { fileTypeIcons } from "./file-type-icons";
import { useRegistryIcon, type IconComponent } from "./registry-icon";

/** `sm` is 16 px and sits in a chip or a line of text, `md` is 24 px, `lg` is 32 px. */
export type SkillIconSize = "sm" | "md" | "lg";

// A drawn page fills the box. A line icon stands bare at `sm` and on the neutral tile at `md`
// and `lg`, drawn smaller inside it, so it weighs as much as a page beside it.
const skillIconBoxes: Record<SkillIconSize, string> = {
  sm: "size-4",
  md: "size-6",
  lg: "size-8"
};

const lineIconSizes: Record<SkillIconSize, string> = {
  sm: "size-3.5 stroke-[1.75]",
  md: "size-3.5",
  lg: "size-4.5"
};

const drawnIcons: ReadonlySet<IconComponent> = new Set(Object.values(fileTypeIcons));

export interface SkillIconProps {
  /**
   * The key of the registry a skill that ships with the platform carries. Every other skill
   * has none and shows the generic skill icon. The key is never taken from the skill's name.
   */
  icon?: string;
  size?: SkillIconSize;
  className?: string;
}

/**
 * The icon of a skill, beside the skill's title. A file-type page stands as drawn. A line icon
 * sits on one neutral tile at `md` and `lg` and stands bare at `sm`: in ink for a skill that
 * ships with the platform, muted for the generic book. The tile is never tinted, because
 * colour means a file type and nothing else. The icon repeats the title, so it is hidden from
 * assistive technology.
 */
export function SkillIcon({ icon, size = "md", className }: SkillIconProps) {
  const { Icon, registered } = useRegistryIcon(icon, undefined, "skill");
  const drawn = drawnIcons.has(Icon);
  const generic = !registered || icon === "skill";
  const tile = !drawn && size !== "sm";
  return (
    <span
      aria-hidden="true"
      data-skill-icon={generic ? "generic" : icon}
      data-skill-icon-tile={tile ? "" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        generic ? "text-muted-foreground" : "text-foreground",
        skillIconBoxes[size],
        tile && "rounded-md bg-secondary",
        className
      )}
    >
      <Icon aria-hidden className={drawn ? "size-full" : lineIconSizes[size]} />
    </span>
  );
}

export interface KnowsHowToItem {
  /** The skill's name for people. */
  title: string;
  /** The key of the registry a shipped skill carries. */
  icon?: string;
}

export interface KnowsHowToProps {
  /** The words before the skills, from the caller: "Knows how to". */
  label: string;
  /** The skills, in the order they were given to the agent. */
  skills: readonly KnowsHowToItem[];
  className?: string;
}

/**
 * One line that says what an agent knows how to do: its skills, each with its icon. It shows
 * nothing for an agent without skills, so a card reserves no room for it.
 */
export function KnowsHowTo({ label, skills, className }: KnowsHowToProps) {
  if (skills.length === 0) {
    return null;
  }
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption", className)}
    >
      <span className="text-muted-foreground">{label}</span>
      <ul aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {skills.map((skill, index) => (
          // An agent may hold two skills of the same title.
          <li key={index} className="flex min-w-0 items-center gap-1">
            <SkillIcon icon={skill.icon} size="sm" />
            <span className="truncate">{skill.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
