import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function connectSampleMcpClient({
  url,
  key
}: {
  url: string;
  key: string;
}): Promise<Client> {
  const client = new Client({ name: "demo-sample-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
