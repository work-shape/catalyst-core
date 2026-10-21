import { mountChatWidget } from "@work-shape/catalyst-chat-ui/widget";
import "./styles.css";

// The page of another site in the browser suite (view-runtime.spec.ts): the site bundles the
// widget, and its own script mounts it with the options it chooses.
declare global {
  interface Window {
    mountChatWidget: typeof mountChatWidget;
  }
}

window.mountChatWidget = mountChatWidget;
