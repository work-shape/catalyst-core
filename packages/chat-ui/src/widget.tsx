import { createRoot, type Root } from "react-dom/client";
import { ChatShell, type ChatShellProps } from "./shell";

export interface MountChatWidgetOptions extends ChatShellProps {
  container: HTMLElement;
}

export interface ChatWidgetHandle {
  unmount(): void;
}

export function mountChatWidget({
  container,
  ...shellProps
}: MountChatWidgetOptions): ChatWidgetHandle {
  const root: Root = createRoot(container);
  root.render(<ChatShell {...shellProps} />);

  return {
    unmount() {
      root.unmount();
    }
  };
}
