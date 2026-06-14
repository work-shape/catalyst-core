import { createContext, useContext, type ReactNode } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";

export interface ToolDisplayPayload {
  kind?: unknown;
  version?: unknown;
  mode?: unknown;
  displayId?: unknown;
  data?: unknown;
}

export interface ToolDisplayRenderInput {
  display: ToolDisplayPayload;
  locale: LocaleCode;
  source: "tool-result" | "message-metadata";
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
}

export type ToolDisplayWidget = (input: ToolDisplayRenderInput) => ReactNode;
export type ToolDisplayWidgetRegistry = Record<string, ToolDisplayWidget>;

interface ToolDisplayWidgetContextValue {
  widgets?: ToolDisplayWidgetRegistry;
}

const ToolDisplayWidgetContext = createContext<ToolDisplayWidgetContextValue>({});

export function ToolDisplayWidgetProvider({
  widgets,
  children
}: {
  widgets?: ToolDisplayWidgetRegistry;
  children: ReactNode;
}) {
  return (
    <ToolDisplayWidgetContext.Provider value={{ widgets }}>
      {children}
    </ToolDisplayWidgetContext.Provider>
  );
}

export function useToolDisplayWidget(): ToolDisplayWidget | undefined {
  const { widgets } = useContext(ToolDisplayWidgetContext);
  if (!widgets) {
    return undefined;
  }

  return (input) => {
    const kind = typeof input.display.kind === "string" ? input.display.kind : undefined;
    const widget = kind ? widgets?.[kind] : undefined;
    return widget?.(input);
  };
}

export function readToolDisplayPayloadFromToolResult(result: unknown): ToolDisplayPayload | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  return isToolDisplayPayload(result.display) ? result.display : undefined;
}

export function isToolDisplayPayload(value: unknown): value is ToolDisplayPayload {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
