// @vitest-environment happy-dom

import {
  assetPagePath,
  inboxItemPath,
  STUDIO_KIND_PATHS
} from "@work-shape/catalyst-asset-schemas";
import { buildAssetKinds } from "@work-shape/catalyst-chat-ui/build-area";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";
import {
  MarkdownArtifact,
  MarkdownLinkPolicyProvider,
  PageLinksProvider,
  pageLinkPath,
  pageLinkRoute,
  workspaceRouteFromPath
} from "./support/chat-ui";

// CHAT-LINK-1: a link in a reply to a page of the app opens that page in place, with the
// conversation docked beside it; the agent links the `href` its tools answer.

const ORIGIN = "https://chat.example.com";

describe("the page a link opens in place", () => {
  it("reads the pages of the route table on the page's own origin", () => {
    expect(pageLinkRoute("/build/data-stores/orders", ORIGIN)).toEqual({
      kind: "build-asset",
      assetKind: "data-stores",
      name: "orders"
    });
    expect(pageLinkRoute(`${ORIGIN}/w/ws_1/app-drafts/offers`, ORIGIN)).toEqual({
      kind: "app-edit",
      collaborationWorkspaceId: "ws_1",
      app: "offers"
    });
    expect(pageLinkRoute("/w/ws_1/apps", ORIGIN)?.kind).toBe("apps");
    expect(pageLinkRoute("/w/ws_1/workflows/intake", ORIGIN)?.kind).toBe("workflow");
    expect(pageLinkRoute("/inbox/req_1", ORIGIN)).toEqual({ kind: "inbox-item", itemId: "req_1" });
  });

  it("leaves unknown paths, other origins and other protocols to the link policy", () => {
    for (const href of [
      "/files/a.pdf",
      "/unknown/page",
      "/",
      "/c/conv_1",
      "#section",
      "mailto:team@example.com",
      "javascript:alert(1)",
      "https://evil.example.net/build/data-stores/orders",
      "//evil.example.net/inbox/req_1",
      "http://chat.example.com/inbox/req_1"
    ]) {
      expect(pageLinkRoute(href, ORIGIN), href).toBeUndefined();
    }
  });

  it("carries the page's own path, never a query or a conversation", () => {
    expect(pageLinkPath("/build/data-stores/orders?chat=conv_9&token=x#schema", ORIGIN)).toBe(
      "/build/data-stores/orders"
    );
  });

  it("is the path the server answers as an asset's href", () => {
    for (const kind of buildAssetKinds) {
      expect(STUDIO_KIND_PATHS[kind.kind], kind.kind).toBe(kind.path);
    }
    const route = (path: string | undefined) =>
      path === undefined ? undefined : workspaceRouteFromPath(path);
    expect(route(assetPagePath({ kind: "data_store", name: "orders" }))).toEqual({
      kind: "build-asset",
      assetKind: "data-stores",
      name: "orders"
    });
    expect(route(assetPagePath({ kind: "app", name: "offers", workspaceId: "ws_1" }))).toEqual({
      kind: "app-edit",
      collaborationWorkspaceId: "ws_1",
      app: "offers"
    });
    expect(route(assetPagePath({ kind: "workflow", name: "intake", workspaceId: "ws_1" }))).toEqual(
      { kind: "workflow", collaborationWorkspaceId: "ws_1", workflow: "intake" }
    );
    expect(route(inboxItemPath("req_1"))).toEqual({ kind: "inbox-item", itemId: "req_1" });
    // No owner, no page: a Workflow or App path is never guessed.
    expect(assetPagePath({ kind: "workflow", name: "intake" })).toBeUndefined();
    expect(assetPagePath({ kind: "toString", name: "x" })).toBeUndefined();
  });
});

describe("a link in a reply", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    vi.unstubAllGlobals();
  });

  function mount(markdown: string, open?: (page: unknown) => void): HTMLElement {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const origin = window.location.origin;
    let tree: ReactNode = createElement(MarkdownArtifact, null, markdown);
    if (open) tree = createElement(PageLinksProvider, { value: { open }, children: tree });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(MarkdownLinkPolicyProvider, {
            allowedLinkHosts: ["docs.example.org"],
            ownOrigins: [origin],
            children: tree
          })
        )
      )
    );
    return host;
  }

  function click(element: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    act(() => {
      element.dispatchEvent(event);
    });
    return event;
  }

  it("opens a page of the app in place, with its own address for a new tab", () => {
    const open = vi.fn();
    const view = mount(
      `Open [Bestellungen](${window.location.origin}/build/data-stores/orders?chat=conv_9) to publish it.`,
      open
    );
    const link = required(view.querySelector("a[data-page-link]"));

    expect(link.getAttribute("href")).toBe("/build/data-stores/orders");
    expect(link.getAttribute("target")).toBeNull();
    expect(link.textContent).toBe("Bestellungen");
    expect(click(link).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith({
      kind: "build-asset",
      assetKind: "data-stores",
      name: "orders"
    });
  });

  it("leaves a click with a modifier key to the browser", () => {
    const open = vi.fn();
    const link = required(
      mount("[Request](/inbox/req_1)", open).querySelector("a[data-page-link]")
    );

    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(click(link, { [modifier]: true }).defaultPrevented).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps every other link as before", () => {
    const open = vi.fn();
    const view = mount(
      ["[File](/files/a.pdf)", "[Guide](https://docs.example.org/guide)"].join("\n\n"),
      open
    );

    expect(view.querySelector("[data-page-link]")).toBeNull();
    expect(view.querySelectorAll('[data-streamdown="link"]')).toHaveLength(2);
  });

  it("stays a link as before where nothing opens a page, as in a mail preview", () => {
    const view = mount("[Bestellungen](/build/data-stores/orders)");

    expect(view.querySelector("[data-page-link]")).toBeNull();
    expect(view.querySelectorAll('[data-streamdown="link"]')).toHaveLength(1);
  });
});
