import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { vivdCatalystChatUiPlugin } from "@vivd-catalyst/chat-ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vivdCatalystChatUiPlugin(), react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"]
  },
  build: {
    outDir: "dist/client"
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
