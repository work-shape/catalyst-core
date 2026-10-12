import {
  Bell,
  Box,
  Clock,
  Code,
  Database,
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
  Workflow
} from "lucide-react";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

/** An icon of the registry. It is drawn at the size its place gives it. */
export type FlowIconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** Icons by key. An application registers its own, such as the marks of the services it joins. */
export type FlowIconRegistry = Readonly<Record<string, FlowIconComponent>>;

/**
 * The icons the library ships: one per kind of part and per category of what a part touches.
 * None of them is a mark of a vendor.
 */
export const flowGenericIcons = {
  agent: Sparkles,
  approval: UserCheck,
  branch: GitBranch,
  code: Code,
  connection: Plug,
  database: Database,
  files: FileText,
  mail: Mail,
  manual: Play,
  notify: Bell,
  repeat: Repeat,
  result: Flag,
  schedule: Clock,
  step: Box,
  subflow: Workflow,
  web: Globe
} satisfies FlowIconRegistry;

export type FlowGenericIconKey = keyof typeof flowGenericIcons;

const FlowIconContext = createContext<FlowIconRegistry>(flowGenericIcons);

/** Adds an application's icons to the generic ones for every `FlowIcon` below it. */
export function FlowIconProvider({
  icons,
  children
}: {
  icons: FlowIconRegistry;
  children: ReactNode;
}) {
  const inherited = useContext(FlowIconContext);
  return <FlowIconContext value={{ ...inherited, ...icons }}>{children}</FlowIconContext>;
}

/** The icon registered under `name`, else the one under `fallback`, else the generic step. */
function resolveFlowIcon(
  registry: FlowIconRegistry,
  name: string | undefined,
  fallback?: string
): FlowIconComponent {
  const found = name === undefined ? undefined : registry[name];
  const second = fallback === undefined ? undefined : registry[fallback];
  return found ?? second ?? flowGenericIcons.step;
}

export interface FlowIconProps {
  /** A key of the registry. */
  name?: string;
  /** The key shown when nothing is registered under `name`. */
  fallback?: string;
  className?: string;
}

/** An icon by its key in the registry, with a generic one for a key nobody registered. */
export function FlowIcon({ name, fallback, className }: FlowIconProps) {
  const Icon = resolveFlowIcon(useContext(FlowIconContext), name, fallback);
  return <Icon aria-hidden className={className} />;
}
