import {
  createContext,
  useContext,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "./cn";
import type { UiLabels } from "./labels";
import { createThemeTokens, type ThemeInputs, type ThemeMode } from "./theme";

interface UiContextValue {
  labels: UiLabels;
  mode: ThemeMode;
}

const UiContext = createContext<UiContextValue | undefined>(undefined);

/**
 * The element overlays render into. `undefined` means no `UiRoot` is above; `null` means the
 * container has not mounted yet, which is the case on the first render and on the server.
 */
const OverlayContainerContext = createContext<HTMLElement | null | undefined>(undefined);

export interface UiRootProps extends HTMLAttributes<HTMLElement> {
  /** The element to render. A page that owns its landmark passes `main`. */
  as?: "div" | "main";
  /** The instance's inputs for `mode`. Without them the stylesheet's default theme shows. */
  theme?: ThemeInputs;
  mode: ThemeMode;
  labels: UiLabels;
}

/**
 * The themed root every library component needs above it. It carries the theme tokens on its
 * own element and holds the container overlays render into, so a tooltip or menu shows this
 * root's theme and never the document's. It does not touch `<html>` or `<body>`, which lets
 * two roots with different themes sit side by side and keeps an embedded root out of its host
 * page.
 */
export function UiRoot({
  as: Element = "div",
  theme,
  mode,
  labels,
  className,
  style,
  children,
  ...props
}: UiRootProps) {
  const [overlayContainer, setOverlayContainer] = useState<HTMLElement | null>(null);
  const tokens = useMemo(() => (theme ? createThemeTokens(theme, mode) : undefined), [theme, mode]);
  const context = useMemo(() => ({ labels, mode }), [labels, mode]);

  return (
    <UiContext value={context}>
      <OverlayContainerContext value={overlayContainer}>
        <Element
          className={cn(mode === "dark" && "dark", className)}
          style={{ ...tokens, ...style }}
          {...props}
        >
          {children}
          <OverlayContainer onMount={setOverlayContainer} />
        </Element>
      </OverlayContainerContext>
    </UiContext>
  );
}

/** The mode of the nearest `UiRoot`, for content that draws outside the stylesheet, such as a frame. */
export function useUiMode(): ThemeMode {
  return useUiContext("useUiMode").mode;
}

export function useUiLabels(component: string): UiLabels {
  return useUiContext(component).labels;
}

/** The container an overlay portals into, or `null` until it has mounted. */
export function useOverlayContainer(component: string): HTMLElement | null {
  const container = useContext(OverlayContainerContext);
  if (container === undefined) {
    throw new Error(missingUiRootMessage(component));
  }
  return container;
}

/**
 * Gives the overlays inside `children` their own container. A modal dialog uses it: a
 * container outside the dialog would be inert and hidden beneath the browser's top layer.
 */
export function OverlayScope({
  children
}: {
  children(container: ReactNode): ReactNode;
}): ReactNode {
  const [overlayContainer, setOverlayContainer] = useState<HTMLElement | null>(null);
  return (
    <OverlayContainerContext value={overlayContainer}>
      {children(<OverlayContainer onMount={setOverlayContainer} />)}
    </OverlayContainerContext>
  );
}

function OverlayContainer({ onMount }: { onMount(element: HTMLElement | null): void }) {
  // `contents` keeps the container out of its parent's layout, whatever that layout is.
  return <div ref={onMount} data-catalyst-overlays="" className="contents" />;
}

function useUiContext(component: string): UiContextValue {
  const context = useContext(UiContext);
  if (!context) {
    throw new Error(missingUiRootMessage(component));
  }
  return context;
}

function missingUiRootMessage(component: string): string {
  return `${component} must be rendered inside UiRoot, which supplies the theme, the labels and the overlay container.`;
}
