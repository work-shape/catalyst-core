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
/** @deprecated Use DomainUiWidget. */
export type DomainUiRenderer = DomainUiWidget;

interface DomainUiWidgetContextValue {
  renderer?: DomainUiRenderer;
  widgets?: DomainUiWidgetRegistry;
}

const DomainUiWidgetContext = createContext<DomainUiWidgetContextValue>({});

export function DomainUiWidgetProvider({
  renderer,
  widgets,
  children
}: {
  renderer?: DomainUiRenderer;
  widgets?: DomainUiWidgetRegistry;
  children: ReactNode;
}) {
  return (
    <DomainUiWidgetContext.Provider value={{ renderer, widgets }}>
      {children}
    </DomainUiWidgetContext.Provider>
  );
}

export function useDomainUiWidget(): DomainUiWidget | undefined {
  const { renderer, widgets } = useContext(DomainUiWidgetContext);
  if (!widgets && !renderer) {
    return undefined;
  }

  return (input) => {
    const kind = typeof input.domainUi.kind === "string" ? input.domainUi.kind : undefined;
    const widget = kind ? widgets?.[kind] : undefined;
    return widget?.(input) ?? renderer?.(input);
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
