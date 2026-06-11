import { createRoot, type Root } from "react-dom/client";
import { ChatShell, type ChatShellProps } from "@vivd-stage/chat-ui/shell";

export interface MountChatWidgetOptions extends ChatShellProps {
  container: HTMLElement;
}

export interface ChatWidgetHandle {
  unmount(): void;
}

export function mountChatWidget(options: MountChatWidgetOptions): ChatWidgetHandle {
  const root: Root = createRoot(options.container);
  root.render(
    <ChatShell
      apiBaseUrl={options.apiBaseUrl}
      token={options.token}
      getToken={options.getToken}
      className={options.className}
    />
  );

  return {
    unmount() {
      root.unmount();
    }
  };
}
