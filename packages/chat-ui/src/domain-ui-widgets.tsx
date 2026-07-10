import { createContext, useContext, type ReactNode } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";

export interface ToolDisplayPayload {
  kind?: unknown;
  version?: unknown;
  mode?: unknown;
  displayId?: unknown;
  title?: unknown;
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

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input, Output> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: Input
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined;
}

export interface StandardSchemaV1Types<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

export type StandardSchemaV1Result<Output> =
  | StandardSchemaV1Success<Output>
  | StandardSchemaV1Failure;

export interface StandardSchemaV1Success<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardSchemaV1Failure {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

export interface StandardSchemaV1Issue {
  readonly message: string;
}

/**
 * Defines a typed tool display widget using a Standard Schema v1 data contract.
 * Async schema validation is not awaited; Promise-returning validators decline
 * rendering so the caller can fall back to the built-in display.
 */
export function defineToolDisplayWidget<TData>({
  kind,
  version,
  dataSchema,
  render
}: {
  kind: string;
  version: number;
  dataSchema: StandardSchemaV1<unknown, TData>;
  render: (props: { data: TData; input: ToolDisplayRenderInput }) => ReactNode;
}): ToolDisplayWidget & { kind: string } {
  const widget: ToolDisplayWidget = (input) => {
    if (input.display.version !== version) {
      return undefined;
    }

    const result = dataSchema["~standard"].validate(input.display.data);
    if (isPromiseLike(result) || isStandardSchemaFailure(result)) {
      return undefined;
    }

    return render({ data: result.value, input });
  };

  return Object.assign(widget, { kind });
}

export function toolDisplayWidgetRegistry(
  ...widgets: Array<ToolDisplayWidget & { kind: string }>
): ToolDisplayWidgetRegistry {
  const registry: ToolDisplayWidgetRegistry = {};
  for (const widget of widgets) {
    if (Object.prototype.hasOwnProperty.call(registry, widget.kind)) {
      throw new Error(`Duplicate tool display widget kind: ${widget.kind}`);
    }
    registry[widget.kind] = widget;
  }
  return registry;
}

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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function isStandardSchemaFailure(
  result: StandardSchemaV1Result<unknown>
): result is StandardSchemaV1Failure {
  return "issues" in result && result.issues !== undefined;
}
