import type { IncomingMessage, ServerResponse } from "node:http";

export interface VivdCatalystChatUiPluginOptions {
  faviconPath?: string | URL;
  faviconPublicPath?: string;
  clientConfigPath?: string;
  brandingBootstrap?: boolean;
}

interface ViteResolvedConfig {
  root: string;
  publicDir: string | false;
  build: {
    outDir: string;
  };
  logger?: {
    warn(message: string): void;
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
  transformIndexHtml?(): Promise<ViteHtmlTagDescriptor[] | undefined>;
  configureServer(server: ViteDevServer): void;
  closeBundle(): void;
}

interface ViteHtmlTagDescriptor {
  tag: string;
  attrs?: Record<string, string>;
  children?: string;
  injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
}

export declare function vivdCatalystChatUiPlugin(
  options?: VivdCatalystChatUiPluginOptions
): VitePlugin;
