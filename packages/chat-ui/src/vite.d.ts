import type { IncomingMessage, ServerResponse } from "node:http";

export interface VivdCatalystChatUiPluginOptions {
  faviconPath?: string | URL;
  faviconPublicPath?: string;
}

interface ViteResolvedConfig {
  root: string;
  publicDir: string | false;
  build: {
    outDir: string;
  };
}

interface ViteDevServer {
  middlewares: {
    use(
      handler: (
        request: IncomingMessage,
        response: ServerResponse,
        next: (error?: unknown) => void
      ) => void
    ): void;
  };
}

interface VitePlugin {
  name: string;
  configResolved(config: ViteResolvedConfig): void;
  configureServer(server: ViteDevServer): void;
  closeBundle(): void;
}

export declare function vivdCatalystChatUiPlugin(
  options?: VivdCatalystChatUiPluginOptions
): VitePlugin;
