import {
  Banknote,
  BookOpen,
  Building2,
  Calculator,
  Calendar,
  ChartColumn,
  ClipboardList,
  FileSignature,
  FileText,
  Globe,
  House,
  KeyRound,
  Landmark,
  Lightbulb,
  ListChecks,
  Mail,
  MessageSquare,
  Pencil,
  Receipt,
  Ruler,
  Scale,
  Search,
  Sparkles,
  Users,
  type LucideIcon
} from "lucide-react";

/**
 * The icons an author may put on a starter, by the name an agent stores. The order is the order
 * a picker shows them in: writing and lists, talking and time, finding and ideas, people and
 * places, law and money, numbers and measures.
 */
export const starterIcons = {
  "file-text": FileText,
  "file-signature": FileSignature,
  "clipboard-list": ClipboardList,
  "list-checks": ListChecks,
  pencil: Pencil,
  "book-open": BookOpen,
  "message-square": MessageSquare,
  mail: Mail,
  calendar: Calendar,
  search: Search,
  lightbulb: Lightbulb,
  sparkles: Sparkles,
  users: Users,
  home: House,
  building: Building2,
  landmark: Landmark,
  key: KeyRound,
  scale: Scale,
  banknote: Banknote,
  receipt: Receipt,
  calculator: Calculator,
  chart: ChartColumn,
  ruler: Ruler,
  globe: Globe
} satisfies Record<string, LucideIcon>;

export type StarterIconKey = keyof typeof starterIcons;

const isStarterIconKey = (name: string): name is StarterIconKey => name in starterIcons;

/** The names of the starter icons, in the order a picker shows them. */
export const starterIconNames: readonly StarterIconKey[] =
  Object.keys(starterIcons).filter(isStarterIconKey);
