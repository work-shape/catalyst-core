import { createContext, useContext, type ReactNode } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";

export interface DomainUiPayload {
  kind?: unknown;
  version?: unknown;
  data?: unknown;
}

export interface DomainUiRenderInput {
  domainUi: DomainUiPayload;
  locale: LocaleCode;
  source: "tool-result" | "message-metadata";
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
}

export type DomainUiWidget = (input: DomainUiRenderInput) => ReactNode;
export type DomainUiWidgetRegistry = Record<string, DomainUiWidget>;

interface DomainUiWidgetContextValue {
  widgets?: DomainUiWidgetRegistry;
}

const DomainUiWidgetContext = createContext<DomainUiWidgetContextValue>({});

export function DomainUiWidgetProvider({
  widgets,
  children
}: {
  widgets?: DomainUiWidgetRegistry;
  children: ReactNode;
}) {
  return (
    <DomainUiWidgetContext.Provider value={{ widgets }}>
      {children}
    </DomainUiWidgetContext.Provider>
  );
}

export function useDomainUiWidget(): DomainUiWidget | undefined {
  const { widgets } = useContext(DomainUiWidgetContext);
  if (!widgets) {
    return undefined;
  }

  return (input) => {
    const kind = typeof input.domainUi.kind === "string" ? input.domainUi.kind : undefined;
    const widget = kind ? widgets?.[kind] : undefined;
    return widget?.(input);
  };
}

export function readDomainUiPayloadFromToolResult(result: unknown): DomainUiPayload | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  return isDomainUiPayload(result.domainUi) ? result.domainUi : undefined;
}

export function isDomainUiPayload(value: unknown): value is DomainUiPayload {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
