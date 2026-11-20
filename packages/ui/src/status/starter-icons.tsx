import {
  Banknote,
  BookOpen,
  Building2,
  Calculator,
  Calendar,
  ChartColumn,
  ClipboardList,
  Euro,
  FileCheck,
  FileSearch,
  FileSignature,
  FileText,
  Files,
  Folder,
  Globe,
  GraduationCap,
  Hammer,
  HandCoins,
  Handshake,
  House,
  KeyRound,
  Landmark,
  Lightbulb,
  ListChecks,
  ListTodo,
  Mail,
  MapPin,
  MessageCircleQuestion,
  MessageSquare,
  MessageSquareText,
  Pencil,
  Percent,
  Phone,
  Presentation,
  Receipt,
  Ruler,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Stamp,
  Target,
  TrendingUp,
  Users,
  type LucideIcon
} from "lucide-react";
import { cn } from "../cn";
import { iconTintClassNames, type IconTint } from "./icon-tile";

/** What a starter icon is about. Its family gives the icon its colour. */
export type StarterIconFamily =
  "documents" | "money" | "property" | "people" | "planning" | "ideas";

const familyTints: Record<StarterIconFamily, IconTint> = {
  documents: "blue",
  money: "green",
  property: "amber",
  people: "violet",
  planning: "teal",
  ideas: "rose"
};

/**
 * The icons an author may put on a starter, by the name an agent stores, family by family in
 * the order a picker shows them.
 */
const iconsByFamily = {
  documents: {
    "file-text": FileText,
    "file-signature": FileSignature,
    "file-check": FileCheck,
    "file-search": FileSearch,
    files: Files,
    folder: Folder,
    "clipboard-list": ClipboardList,
    stamp: Stamp,
    scale: Scale,
    pencil: Pencil,
    "book-open": BookOpen,
    presentation: Presentation
  },
  money: {
    banknote: Banknote,
    euro: Euro,
    "hand-coins": HandCoins,
    receipt: Receipt,
    calculator: Calculator,
    percent: Percent,
    chart: ChartColumn,
    "trending-up": TrendingUp
  },
  property: {
    home: House,
    building: Building2,
    landmark: Landmark,
    key: KeyRound,
    "map-pin": MapPin,
    hammer: Hammer,
    ruler: Ruler
  },
  people: {
    users: Users,
    handshake: Handshake,
    "message-square": MessageSquare,
    "message-circle-question": MessageCircleQuestion,
    mail: Mail,
    phone: Phone,
    "graduation-cap": GraduationCap
  },
  planning: {
    calendar: Calendar,
    "list-checks": ListChecks,
    "list-todo": ListTodo,
    target: Target,
    "shield-check": ShieldCheck
  },
  ideas: {
    lightbulb: Lightbulb,
    sparkles: Sparkles,
    search: Search,
    globe: Globe
  }
} satisfies Record<StarterIconFamily, Record<string, LucideIcon>>;

type IconsByFamily = typeof iconsByFamily;

export type StarterIconKey = {
  [Family in StarterIconFamily]: keyof IconsByFamily[Family];
}[StarterIconFamily];

const familyNames: readonly StarterIconFamily[] = [
  "documents",
  "money",
  "property",
  "people",
  "planning",
  "ideas"
];

const drawings = new Map<string, { Icon: LucideIcon; family: StarterIconFamily }>();
const isStarterIconKey = (name: string): name is StarterIconKey => drawings.has(name);
for (const family of familyNames) {
  for (const [name, Icon] of Object.entries(iconsByFamily[family])) {
    drawings.set(name, { Icon, family });
  }
}

/** The names of the starter icons, in the order a picker shows them. */
export const starterIconNames: readonly StarterIconKey[] = [...drawings.keys()].filter(
  isStarterIconKey
);

/** The starter icons family by family, each with its names, in the order a picker shows them. */
export const starterIconFamilies: readonly {
  family: StarterIconFamily;
  names: readonly StarterIconKey[];
}[] = familyNames.map((family) => ({
  family,
  names: starterIconNames.filter((name) => drawings.get(name)?.family === family)
}));

/** `sm` is 24 px, for a short card and a picker; `md` is 32 px. */
export type StarterIconSize = "sm" | "md";

const boxes: Record<StarterIconSize, string> = {
  sm: "size-6 [&_svg]:size-3.5",
  md: "size-8 [&_svg]:size-4.5"
};

export interface StarterIconProps {
  /** The name an agent stores. None, or one nobody draws, shows the neutral speech bubble. */
  icon?: string;
  size?: StarterIconSize;
  className?: string;
}

/**
 * The icon of a starter an agent's author wrote, on a tile in the colour of the icon's family:
 * the author picks the icon and never the colour. A starter without an icon shows the speech
 * bubble on the neutral tile. The icon repeats the title, so it is hidden from assistive
 * technology.
 */
export function StarterIcon({ icon, size = "md", className }: StarterIconProps) {
  const drawing = icon === undefined ? undefined : drawings.get(icon);
  const Icon = drawing?.Icon ?? MessageSquareText;
  return (
    <span
      aria-hidden="true"
      data-starter-icon={drawing === undefined ? "default" : icon}
      data-starter-icon-family={drawing?.family}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md",
        drawing === undefined
          ? "bg-secondary text-foreground"
          : iconTintClassNames[familyTints[drawing.family]],
        boxes[size],
        className
      )}
    >
      <Icon aria-hidden />
    </span>
  );
}
