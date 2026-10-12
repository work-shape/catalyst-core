import {
  Bell,
  BookOpen,
  Box,
  Clock,
  Code,
  Database,
  File,
  FileText,
  Flag,
  GitBranch,
  Globe,
  Mail,
  Play,
  Plug,
  Repeat,
  Sparkles,
  UserCheck,
  Workflow,
  Wrench
} from "lucide-react";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

/** An icon of the registry. It is drawn at the size its place gives it. */
export type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** Icons by key. An application registers its own, such as the marks of the services it joins. */
export type IconRegistry = Readonly<Record<string, IconComponent>>;

/** What a key stands for. A key nobody registered shows the generic icon of its family. */
export type IconFamily = "file" | "service" | "skill" | "tool";

/**
 * The icons the library ships: one per family, one per kind of part of a graph and one per
 * category of what a part touches. None of them is a mark of a vendor or of a file type.
 */
export const genericIcons = {
  agent: Sparkles,
  approval: UserCheck,
  branch: GitBranch,
  code: Code,
  connection: Plug,
  database: Database,
  file: File,
  files: FileText,
  mail: Mail,
  manual: Play,
  notify: Bell,
  repeat: Repeat,
  result: Flag,
  schedule: Clock,
  service: Plug,
  skill: BookOpen,
  step: Box,
  subflow: Workflow,
  tool: Wrench,
  web: Globe
} satisfies IconRegistry;

export type GenericIconKey = keyof typeof genericIcons;

const IconRegistryContext = createContext<IconRegistry>(genericIcons);

/** Adds an application's icons to the generic ones for every `RegistryIcon` below it. */
export function IconRegistryProvider({
  icons,
  children
}: {
  icons: IconRegistry;
  children: ReactNode;
}) {
  const inherited = useContext(IconRegistryContext);
  return <IconRegistryContext value={{ ...inherited, ...icons }}>{children}</IconRegistryContext>;
}

/**
 * The icon registered under `name`, else the one under `fallback`, else the generic icon of
 * the family, else the generic step.
 */
function resolveIcon(
  registry: IconRegistry,
  name: string | undefined,
  fallback: string | undefined,
  family: IconFamily | undefined
): IconComponent {
  const found = name === undefined ? undefined : registry[name];
  const second = fallback === undefined ? undefined : registry[fallback];
  // An application may register its own icon for a family under the family's key.
  const third = family === undefined ? undefined : (registry[family] ?? genericIcons[family]);
  return found ?? second ?? third ?? genericIcons.step;
}

export interface RegistryIconProps {
  /** A key of the registry. */
  name?: string;
  /** The key shown when nothing is registered under `name`. */
  fallback?: string;
  /** What the key stands for: its generic icon shows when neither key is registered. */
  family?: IconFamily;
  className?: string;
}

/** An icon by its key in the registry, with a generic one for a key nobody registered. */
export function RegistryIcon({ name, fallback, family, className }: RegistryIconProps) {
  const Icon = resolveIcon(useContext(IconRegistryContext), name, fallback, family);
  return <Icon aria-hidden className={className} />;
}
