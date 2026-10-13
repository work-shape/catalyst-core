import { cn } from "../cn";
import { RegistryIcon } from "./registry-icon";

/** `sm` is 16 px and sits in a chip or a line of text, `md` is 24 px, `lg` is 32 px. */
export type SkillIconSize = "sm" | "md" | "lg";

// A drawn icon, such as a file-type page, fills the box. A line icon is drawn smaller inside
// it, so the generic book weighs as much as a page beside it.
const skillIconSizes: Record<SkillIconSize, string> = {
  sm: "size-4 [&_.lucide]:size-3! [&_.lucide]:stroke-2",
  md: "size-6 [&_.lucide]:size-5!",
  lg: "size-8 [&_.lucide]:size-5!"
};

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
 * The icon of a skill, beside the skill's title. It is a page or the generic book and never
 * sits on a tile: a tile is the mark of a Connection. It repeats the title, so it is hidden
 * from assistive technology.
 */
export function SkillIcon({ icon, size = "md", className }: SkillIconProps) {
  return (
    <span
      aria-hidden="true"
      data-skill-icon={icon ?? "generic"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-full!",
        skillIconSizes[size],
        className
      )}
    >
      <RegistryIcon name={icon} family="skill" />
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
