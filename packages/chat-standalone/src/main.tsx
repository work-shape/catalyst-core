import { superadminPanel } from "@vivd-catalyst/chat-ui/admin";
import { renderStandaloneChatApp } from "@vivd-catalyst/chat-ui/shell";
import "@vivd-catalyst/chat-ui/styles.css";

renderStandaloneChatApp({
  apiBaseUrl: import.meta.env.VITE_CHAT_API_URL,
  defaultApiPort: import.meta.env.VITE_CHAT_API_PORT,
  adminPanel: superadminPanel
});
