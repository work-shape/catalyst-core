import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  ownTokenHeaderOf,
  ownTokenIssuesOf,
  ownTokenSchemeOf,
  saveOwnToken,
  withOwnTokenScheme,
  ownServerAddressIssue,
  ownServerConfig,
  ownServerHostOf,
  ownServerName,
  ownServerProbeStep,
  ownServerSuffix,
  ownServerTitle,
  ownServerViewOf,
  splitOwnServers,
  withKeptOperations
} from "@work-shape/catalyst-chat-ui/build-area";
import { CONNECTION_NAME_MAX_LENGTH, CONNECTION_NAME_PATTERN } from "@work-shape/catalyst-core";

// A person's own MCP server on You > Connections (PMCP-5): what the add dialog takes and
// writes, and how a card reads. The instance decides every write; these decide what is shown
// and sent.

describe("the address the add dialog takes", () => {
  it("takes a web address and refuses a name, a password and anything from ? or # on", () => {
    expect(ownServerAddressIssue("https://notes.example.com/mcp")).toBeUndefined();
    expect(ownServerAddressIssue("  https://notes.example.com/mcp  ")).toBeUndefined();
    expect(ownServerAddressIssue("")).toBe("empty");
    expect(ownServerAddressIssue("notes.example.com/mcp")).toBe("invalid");
    expect(ownServerAddressIssue("ftp://notes.example.com/mcp")).toBe("invalid");
    expect(ownServerAddressIssue("https://me:secret@notes.example.com/mcp")).toBe("credentials");
    expect(ownServerAddressIssue("https://token@notes.example.com/mcp")).toBe("credentials");
    expect(ownServerAddressIssue("https://notes.example.com/mcp?key=1")).toBe("query");
    expect(ownServerAddressIssue("https://notes.example.com/mcp#top")).toBe("query");
    expect(ownServerAddressIssue("https://notes.example.com/mcp?")).toBe("query");
  });

  it("names the host, and starts the title with it", () => {
    expect(ownServerHostOf("https://notes.example.com/mcp")).toBe("notes.example.com");
    expect(ownServerHostOf("https://notes.example.com:8443/mcp")).toBe("notes.example.com:8443");
    expect(ownServerTitle("notes.example.com:8443")).toBe("notes.example.com");
  });
});

describe("the name the dialog writes", () => {
  it("is the host in words and six random characters, and always a Connection name", () => {
    expect(ownServerName("notes.example.com", "a1b2c3")).toBe("notes-example-com-a1b2c3");
    expect(ownServerName("127.0.0.1:4219", "a1b2c3")).toBe("mcp-127-0-0-1-a1b2c3");
    const long = ownServerName(`${"very-long-name.".repeat(10)}example.com`, "a1b2c3");
    expect(long.length).toBeLessThanOrEqual(CONNECTION_NAME_MAX_LENGTH);
    for (const host of ["Notes.Example.COM", "x--y.example", "9.example", long]) {
      expect(ownServerName(host, ownServerSuffix())).toMatch(CONNECTION_NAME_PATTERN);
    }
    expect(ownServerSuffix()).toMatch(/^[a-z0-9]{6}$/u);
    expect(ownServerSuffix(() => 0)).toBe("aaaaaa");
  });

  it("writes an own server in the person's mode with OAuth and no tool", () => {
    expect(
      ownServerConfig({ name: "notes-a1b2c3", url: " https://n.example/mcp ", title: "Notes" })
    ).toEqual({
      name: "notes-a1b2c3",
      connectorType: "mcp",
      credentialMode: "user",
      authScheme: "oauth",
      displayName: "Notes",
      settings: { url: "https://n.example/mcp" },
      operations: [],
      enabled: true,
      ownerOnly: true
    });
  });
});

describe("what the probe's answer leads to", () => {
  it("goes on to the sign-in, or to a pasted token where the server asks for one", () => {
    expect(ownServerProbeStep("oauth_required")).toBe("sign_in");
    expect(ownServerProbeStep("ready")).toBe("no_sign_in");
    expect(ownServerProbeStep("token_required")).toBe("token");
    expect(ownServerProbeStep("network_denied")).toBe("egress");
    expect(ownServerProbeStep("unavailable")).toBe("unreachable");
    expect(ownServerProbeStep("unauthorized")).toBe("unreachable");
  });
});

describe("the cards", () => {
  const own = {
    name: "notes-a1b2c3",
    title: "Notes",
    state: "connected" as const,
    ownServer: { host: "notes.example.com", enabled: true, tools: 2 }
  };
  it("puts the own servers apart from the personal Connections an admin set up", () => {
    const admin = { name: "mail", title: "Mail", state: "not_connected" as const };
    const split = splitOwnServers([admin, own]);
    expect(split.own.map((row) => row.name)).toEqual(["notes-a1b2c3"]);
    expect(split.personal.map((row) => row.name)).toEqual(["mail"]);
  });

  it("reads a switched-off server as off, whatever its sign-in", () => {
    expect(ownServerViewOf(own)).toBe("connected");
    expect(ownServerViewOf({ ...own, state: "needs_reconnect" })).toBe("needs_reconnect");
    expect(ownServerViewOf({ ...own, ownServer: { ...own.ownServer, enabled: false } })).toBe(
      "off"
    );
  });
});

describe("Tools ändern", () => {
  it("keeps the accepted tools left ticked, each as stored, with the effect chosen", () => {
    const config = {
      name: "notes-a1b2c3",
      operations: [
        { name: "search", effect: "reading", exposure: ["agent"], schemaFingerprint: "f1" },
        { name: "create_page", effect: "changing", exposure: ["agent"] },
        { name: "delete_page", effect: "changing", exposure: ["agent"] }
      ]
    };
    expect(
      withKeptOperations(
        config,
        new Set(["search", "create_page"]),
        new Map([["search", "changing"]])
      )
    ).toEqual({
      name: "notes-a1b2c3",
      operations: [
        { name: "search", effect: "changing", exposure: ["agent"], schemaFingerprint: "f1" },
        { name: "create_page", effect: "changing", exposure: ["agent"] }
      ]
    });
  });
});

describe("a pasted token (PMCP-6)", () => {
  const signIn = ownServerConfig({
    name: "notes_example_com_abc123",
    url: "https://notes.example.com/mcp",
    title: "notes.example.com"
  });

  it("goes as a Bearer token unless a header is named, and only under a header name", () => {
    expect(ownTokenSchemeOf("")).toEqual({ authScheme: "bearer" });
    expect(ownTokenSchemeOf(" Authorization ")).toEqual({ authScheme: "bearer" });
    expect(ownTokenSchemeOf("X-Notes-Key")).toEqual({
      authScheme: "header",
      headerName: "X-Notes-Key"
    });
    for (const invalid of ["X Notes", "1-key", "X-Key:", "X-Key\nHost", "x".repeat(65)]) {
      expect(ownTokenSchemeOf(invalid)).toBeUndefined();
    }
  });

  it("writes how it is sent into the definition, and nothing where it is unchanged", () => {
    const bearer = withOwnTokenScheme(signIn, { authScheme: "bearer" });
    expect(bearer).toMatchObject({
      authScheme: "bearer",
      settings: { url: "https://notes.example.com/mcp" }
    });
    expect(bearer?.settings).not.toHaveProperty("headerName");
    expect(bearer && withOwnTokenScheme(bearer, { authScheme: "bearer" })).toBeUndefined();
    const header = withOwnTokenScheme(signIn, { authScheme: "header", headerName: "X-Notes-Key" });
    expect(header).toMatchObject({ authScheme: "header", settings: { headerName: "X-Notes-Key" } });
    expect(header && ownTokenHeaderOf(header)).toBe("X-Notes-Key");
    expect(ownTokenHeaderOf(signIn)).toBe("");
    // Back to a Bearer token, the header's name goes.
    expect(
      header && withOwnTokenScheme(header, { authScheme: "bearer" })?.settings
    ).not.toHaveProperty("headerName");
  });

  it("is asked for before anything is sent, and the header only where the person names it", () => {
    const t = (key: string) => key;
    expect(ownTokenIssuesOf({ token: " ", header: "" }, true, t)).toEqual({
      token: "ownServers.tokenEmpty"
    });
    expect(ownTokenIssuesOf({ token: "abc", header: "X Key" }, true, t)).toEqual({
      header: "ownServers.headerInvalid"
    });
    expect(ownTokenIssuesOf({ token: "abc", header: "X Key" }, false, t)).toBeUndefined();
    expect(ownTokenIssuesOf({ token: "abc", header: "" }, true, t)).toBeUndefined();
  });

  it("is sent once, through set_own_secret alone, after how it is sent where that changed", async () => {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === "GET" ? undefined : await request.json();
      sent.push({ method: request.method, path, body });
      if (path.endsWith("/own-secret")) return Response.json({ state: "set", version: 1 });
      if (request.method === "GET") {
        return Response.json({
          id: "asset-1",
          kind: "connection",
          name: "notes",
          scope: { kind: "instance" },
          revision: 4,
          updatedAt: "2026-11-11T10:00:00.000Z",
          config: { name: "notes", ...signIn }
        });
      }
      return Response.json({ version: 9, revision: 5, warnings: [] });
    };
    const client = createApiClient({ baseUrl: "http://chat.instance.test", fetchImpl });
    const secret = "pasted-token-value";
    expect(
      await saveOwnToken(client, {
        name: "notes",
        token: secret,
        header: "X-Notes-Key",
        version: 3
      })
    ).toBe(1);
    const asset = apiOperations["assets.get"].buildPath({
      params: { kind: "connection", name: "notes" }
    });
    const ownSecret = apiOperations["connections.set_own_secret"].buildPath({
      params: { name: "notes" }
    });
    expect(sent.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      `GET ${asset}`,
      `PUT ${asset}`,
      `PUT ${ownSecret}`
    ]);
    expect(sent[1]?.body).toMatchObject({
      expectedRevision: 4,
      config: { authScheme: "header", settings: { headerName: "X-Notes-Key" } }
    });
    // A changed scheme ends every token, so the token is a first one.
    expect(sent[2]?.body).toEqual({ value: secret, expectedVersion: null });
    // The token travels in the one request that stores it.
    expect(sent.filter((entry) => JSON.stringify(entry.body ?? "").includes(secret))).toHaveLength(
      1
    );

    sent.length = 0;
    await saveOwnToken(client, { name: "notes", token: secret, version: 2 });
    expect(sent).toEqual([
      {
        method: "PUT",
        path: ownSecret,
        body: { value: secret, expectedVersion: 2 }
      }
    ]);
  });
});
