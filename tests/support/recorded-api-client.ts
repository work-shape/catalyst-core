import { createApiClient, type ApiClient } from "@vivd-catalyst/api-client";
import { apiOperations } from "@vivd-catalyst/api-contract";

/** One call a client made, by the operation of the catalog its request names. */
export interface RecordedApiCall {
  operation: keyof typeof apiOperations;
  params: Record<string, string>;
  query: Record<string, string>;
  /** The body as it was sent. Empty where the call has none. */
  body: string;
}

function operationOf(
  method: string,
  pathname: string
): Pick<RecordedApiCall, "operation" | "params"> | undefined {
  const segments = pathname.split("/");
  for (const operation of Object.values(apiOperations)) {
    const pattern = operation.path.split("/");
    if (operation.method !== method || pattern.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    const fits = pattern.every((part, position) => {
      const segment = segments[position] ?? "";
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(segment);
        return true;
      }
      return part === segment;
    });
    if (fits) {
      return { operation: operation.id, params };
    }
  }
  return undefined;
}

/**
 * The release's own client over no instance: each request is read back as the operation of
 * the catalog it names, kept in `calls`, and answered with what `answer` gives as JSON. So a
 * test of a caller of the client names operations and no path.
 */
export function recordedApiClient(answer: (call: RecordedApiCall) => unknown): {
  client: ApiClient;
  calls: RecordedApiCall[];
} {
  const calls: RecordedApiCall[] = [];
  const client = createApiClient({
    baseUrl: "https://chat.example/",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const named = operationOf(request.method, url.pathname);
      if (!named) {
        throw new Error(`No operation of the catalog answers ${request.method} ${url.pathname}`);
      }
      const call = {
        ...named,
        query: Object.fromEntries(url.searchParams),
        body: await request.text()
      };
      calls.push(call);
      return Response.json(answer(call));
    }
  });
  return { client, calls };
}
