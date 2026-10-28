import { describe, expect, it } from "vitest";
import { createConfigApi } from "@work-shape/catalyst-cli";
import { listen, headersOf, jsonResponse } from "../support/config-cli";

describe("config CLI API transport", () => {
  it("reports invalid JSON during API-key exchange without exposing the response body", async () => {
    const responseBody = "upstream response body must stay private";
    const failure = await createConfigApi({
      baseUrl: "https://catalyst.example.test",
      apiKey: "cat_invalid_json_secret",
      fetchImpl: async () => new Response(responseBody, { status: 502 })
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ApiKeyExchangeError",
      message: "API key exchange failed: Catalyst API returned invalid JSON (HTTP 502)"
    });
    expect(String(failure)).not.toContain(responseBody);
  });

  it("reports invalid JSON from an authenticated config request without exposing its body", async () => {
    const responseBody = "upstream config response body must stay private";
    let requestCount = 0;
    const api = await createConfigApi({
      baseUrl: "https://catalyst.example.test",
      apiKey: "cat_invalid_config_json_secret",
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? jsonResponse(200, {
              accessToken: "short-lived-access-token",
              expiresAt: "2030-01-01T00:00:00.000Z"
            })
          : new Response(responseBody, { status: 503 });
      }
    });

    const failure = await api.getOverview().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "Catalyst API returned invalid JSON (HTTP 503)"
    });
    expect(String(failure)).not.toContain(responseBody);
  });

  it("follows no redirect, so the key reaches neither another host nor another path", async () => {
    const apiKey = "cat_redirect_secret_that_must_stay_home";
    const elsewhere = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const sameHost: string[] = [];
    const instance = await listen((request, response) => {
      sameHost.push(request.url ?? "");
      const target =
        request.headers["x-test-target"] === "same-host" ? "/moved" : `${elsewhere.url}/moved`;
      response.writeHead(307, { location: target }).end();
    });

    const toAnotherHost = await createConfigApi({ baseUrl: instance.url, apiKey }).catch(
      (error: unknown) => error
    );
    const toAnotherPath = await createConfigApi({
      baseUrl: instance.url,
      apiKey,
      fetchImpl: (input, init) =>
        fetch(input, { ...init, headers: { ...headersOf(init), "x-test-target": "same-host" } })
    }).catch((error: unknown) => error);

    for (const failure of [toAnotherHost, toAnotherPath]) {
      expect(failure).toMatchObject({ name: "ApiKeyExchangeError" });
      expect(String(failure)).toContain("answered with a redirect (HTTP 307)");
      expect(String(failure)).not.toContain(apiKey);
    }
    expect(elsewhere.requests).toEqual([]);
    // Each call reached the instance once, with the exchange, and never asked for /moved.
    expect(sameHost.map((path) => path.endsWith("/auth/access-token"))).toEqual([true, true]);
  });

  it("rejects unsupported API-key URL schemes before fetching", async () => {
    let fetchCount = 0;

    await expect(
      createConfigApi({
        baseUrl: "ftp://catalyst.example.test",
        apiKey: "cat_unsupported_scheme_secret",
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse(500, {});
        }
      })
    ).rejects.toThrow("unsupported URL scheme 'ftp:'");
    expect(fetchCount).toBe(0);
  });
});

describe("CLI response diagnostics", () => {
  it("sends the CLI version on exchange and authenticated calls", async () => {
    const { RELEASE_VERSION } = await import("@work-shape/catalyst-api-contract");
    const versions: (string | null)[] = [];
    const api = await createConfigApi({
      baseUrl: "https://instance.test",
      apiKey: "private-key",
      fetchImpl: async (input, init) => {
        versions.push(new Headers(init?.headers).get("catalyst-cli-version"));
        return String(input).endsWith("/auth/access-token")
          ? Response.json({ accessToken: "private-token", expiresAt: "2030-01-01T00:00:00.000Z" })
          : Response.json({
              status: "ok",
              clientInstanceId: "instance",
              time: "2030-01-01T00:00:00.000Z"
            });
      }
    });
    await api.read((client) => client.health.get());
    expect(versions).toEqual([RELEASE_VERSION, RELEASE_VERSION]);
  });

  it.each([
    ["text/html", "<html>private content</html>", "an HTML page instead of API JSON"],
    [
      "application/json",
      '{"private":"content"}',
      "other JSON that does not match the API contract"
    ],
    ["text/plain", "private content", "non-JSON text"]
  ])(
    "names the reached URL and category of an unexpected 200 (%s)",
    async (type, body, description) => {
      const failure = await createConfigApi({
        baseUrl: "https://instance.test/wrong-path",
        apiKey: "private-key",
        fetchImpl: async () => new Response(body, { headers: { "content-type": type } })
      }).catch((error: unknown) => error);
      expect(String(failure)).toContain(
        `https://instance.test/wrong-path/api/v1/auth/access-token returned ${description} (HTTP 200, ${type})`
      );
      expect(String(failure)).not.toContain(body);
      expect(String(failure)).not.toContain("private-key");
    }
  );

  it("keeps the right response URL when concurrent reads fail differently", async () => {
    const api = await createConfigApi({
      baseUrl: "https://instance.test",
      apiKey: "private-key",
      fetchImpl: async (input) =>
        String(input).endsWith("/auth/access-token")
          ? Response.json({ accessToken: "private-token", expiresAt: "2030-01-01T00:00:00.000Z" })
          : String(input).endsWith("/context")
            ? new Response("<html>private page</html>", {
                headers: { "content-type": "text/html" }
              })
            : Response.json({ private: "other body" })
    });
    const results = await Promise.allSettled([
      api.read((client) => client.platform.context.get()),
      api.getOverview()
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: {
        message: expect.stringContaining(
          "https://instance.test/api/v1/context returned an HTML page"
        )
      }
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { message: expect.stringContaining("other JSON") }
    });
    expect(JSON.stringify(results)).not.toContain("private page");
  });

  it("redacts URL credentials and query strings in response diagnostics", async () => {
    const failure = await createConfigApi({
      baseUrl: "https://user:password@instance.test",
      apiKey: "private-key",
      fetchImpl: async () => Response.json({ private: "body" })
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain("https://instance.test/api/v1/auth/access-token");
    expect(String(failure)).not.toContain("password");
  });
});
