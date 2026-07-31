import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";

export interface ToolDisplayPayload {
  kind?: unknown;
  version?: unknown;
  mode?: unknown;
  displayId?: unknown;
  title?: unknown;
  data?: unknown;
}

/**
 * What a widget may do beyond rendering. Absent whenever the display is shown
 * without a live conversation behind it — a stored resource opened later, for
 * example — so widgets must treat every action as optional and hide the
 * affordance rather than render a control that cannot work.
 */
export interface ToolDisplayActions {
  /**
   * Send `text` to the conversation as if the user had typed and sent it.
   * Absent while the conversation cannot accept a message — a run is still
   * streaming, for example. That is a different state from having no actions at
   * all: the conversation is there, just busy, so a widget should keep the
   * control in place and disable it rather than remove it.
   */
  sendMessage?(text: string): void;
  /**
   * Open one of the conversation's source files in the display panel. `fileId`
   * is the managed file id the agent also sees on its attachments, so a widget
   * can pass through whatever the tool recorded as evidence.
   */
  openSourceFile(input: { fileId: string; filename?: string }): void;
}

export interface ToolDisplayRenderInput {
  display: ToolDisplayPayload;
  locale: LocaleCode;
  source: "tool-result" | "message-metadata";
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  actions?: ToolDisplayActions;
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

interface ToolDisplayActionsContextValue {
  actions?: ToolDisplayActions;
  register?: (actions: ToolDisplayActions | undefined) => void;
}

const ToolDisplayActionsContext = createContext<ToolDisplayActionsContextValue>({});

/**
 * Holds the actions available to widgets. It sits above the conversation so
 * that displays rendered outside the thread — the side panel, the resources
 * list — reach the same actions; whichever component owns the live thread
 * registers them with {@link useRegisterToolDisplayActions}.
 */
export function ToolDisplayActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ToolDisplayActions | undefined>(undefined);
  const value = useMemo(() => ({ actions, register: setActions }), [actions]);

  return (
    <ToolDisplayActionsContext.Provider value={value}>{children}</ToolDisplayActionsContext.Provider>
  );
}

export function useToolDisplayActions(): ToolDisplayActions | undefined {
  return useContext(ToolDisplayActionsContext).actions;
}

/**
 * Publishes actions to every widget below the provider. Pass `undefined` while
 * sending is unavailable so widgets hide their controls instead of offering an
 * action that would silently do nothing.
 */
export function useRegisterToolDisplayActions(actions: ToolDisplayActions | undefined): void {
  const { register } = useContext(ToolDisplayActionsContext);
  const latest = useRef(actions);
  const available = Boolean(actions);
  const canSendMessage = Boolean(actions?.sendMessage);

  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    if (!register) {
      return;
    }
    register(
      available
        ? {
            ...(canSendMessage
              ? { sendMessage: (text: string) => latest.current?.sendMessage?.(text) }
              : {}),
            openSourceFile: (input) => latest.current?.openSourceFile(input)
          }
        : undefined
    );
    return () => {
      register(undefined);
    };
  }, [available, canSendMessage, register]);
}

export function useToolDisplayWidget(): ToolDisplayWidget | undefined {
  const { widgets } = useContext(ToolDisplayWidgetContext);
  const actions = useToolDisplayActions();
  if (!widgets) {
    return undefined;
  }

  return (input) => {
    const kind = typeof input.display.kind === "string" ? input.display.kind : undefined;
    const widget = kind ? widgets?.[kind] : undefined;
    return widget?.({ ...input, actions });
  };
}

/**
 * Renders a display inside long-lived containers such as the side panel. The
 * wrapper stays subscribed to action-context changes, unlike a widget node that
 * was created once and then stored in panel state.
 */
export function ToolDisplayWidgetNode({
  fallback,
  ...input
}: Omit<ToolDisplayRenderInput, "actions"> & { fallback?: ReactNode }) {
  const widget = useToolDisplayWidget();
  const rendered = widget?.(input);
  return rendered === undefined || rendered === null || rendered === false
    ? (fallback ?? null)
    : rendered;
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
