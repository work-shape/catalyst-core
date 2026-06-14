import { superadminPanel } from "@vivd-catalyst/chat-ui/admin";
import { renderStandaloneChatApp } from "@vivd-catalyst/chat-ui/shell";
import { demoDisplayWidgets } from "../widgets";
import "./styles.css";

renderStandaloneChatApp({
  apiBaseUrl: import.meta.env.VITE_CHAT_API_URL,
  adminPanel: superadminPanel,
  displayWidgets: demoDisplayWidgets
});
