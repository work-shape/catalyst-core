import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAuthSession,
  signInWithEmail,
  signOut,
  type ApiClient
} from "@vivd-catalyst/api-client";
import {
  WorkspaceApiClientProvider,
  useWorkspaceApiClient
} from "../packages/chat-ui/src/api/workspace-api-client";

const requireFromChatUi = createRequire(
  new URL("../packages/chat-ui/package.json", import.meta.url)
);
const { createElement }: typeof import("../packages/chat-ui/node_modules/@types/react") =
  requireFromChatUi("react");
const {
  renderToStaticMarkup
}: typeof import("../packages/chat-ui/node_modules/@types/react-dom/server") =
  requireFromChatUi("react-dom/server");

afterEach(() => vi.unstubAllGlobals());

describe("standalone auth client", () => {
  it("keeps an empty widget token in token mode with cookies omitted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);
    let client: ApiClient | undefined;
    function CaptureClient() {
      client = useWorkspaceApiClient().client;
      return null;
    }
    renderToStaticMarkup(
      createElement(WorkspaceApiClientProvider, {
        apiBaseUrl: "https://chat.example.test",
        token: "",
        children: createElement(CaptureClient)
      })
    );
    if (!client) throw new Error("Provider did not expose its client");

    expect(client.browserManagedDownloads).toBe(false);
    await expect(client.conversations.list()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(request instanceof Request && request.credentials).toBe("omit");
  });

  it("uses cookies without explicit credential headers for every auth call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(null));
    vi.stubGlobal("fetch", fetchMock);

    await getAuthSession("https://chat.example.test");
    await signInWithEmail({
      apiBaseUrl: "https://chat.example.test",
      email: "user@example.test",
      password: "test-password"
    });
    await signOut("https://chat.example.test");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.credentials).toBe("include");
      const headers = new Headers(options?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("x-server-credential")).toBe(false);
    }
  });
});
