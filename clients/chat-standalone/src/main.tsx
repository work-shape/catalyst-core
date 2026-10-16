import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { renderStandaloneChatApp } from "@work-shape/catalyst-chat-ui/shell";
import "./styles.css";

renderStandaloneChatApp({
  apiBaseUrl: import.meta.env.VITE_CHAT_API_URL,
  defaultApiPort: import.meta.env.VITE_CHAT_API_PORT,
  administration
});
