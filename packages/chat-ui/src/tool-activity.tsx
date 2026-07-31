import { createContext, useContext, type ReactNode } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";

export type ToolActivityLabels = Record<
  string,
  string | Partial<Record<LocaleCode, string>>
>;

const ToolActivityLabelsContext = createContext<ToolActivityLabels>({});

export function ToolActivityLabelsProvider({
  labels,
  children
}: {
  labels?: ToolActivityLabels;
  children: ReactNode;
}) {
  return (
    <ToolActivityLabelsContext.Provider value={labels ?? {}}>
      {children}
    </ToolActivityLabelsContext.Provider>
  );
}

export function useToolActivityLabel(toolName: string | undefined, locale: LocaleCode) {
  const labels = useContext(ToolActivityLabelsContext);
  if (!toolName) {
    return undefined;
  }
  const label = labels[toolName];
  if (typeof label === "string") {
    return label;
  }
  return label?.[locale] ?? label?.en ?? label?.de;
}
