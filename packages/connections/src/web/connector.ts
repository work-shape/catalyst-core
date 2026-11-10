import {
  connectionCallError,
  DocumentSourceError,
  type ConnectorTypeDefinition,
  type JsonObject
} from "@work-shape/catalyst-core";
import { sourceHttpTransport, type SourceHttpTransport } from "../document-source/http";
import { createWebSession, WebRefusal } from "./fetch";
import { webSettingsSchema, WEB_CONNECTOR_TYPE } from "./settings";
import { createWebSource } from "./source";

// The `web` Connector type (KB-WEB): public web pages as a synced source of a Knowledge Base.
// It lives in core beside `http_api` and `mcp`: it names no vendor, holds no credential and
// reads only what anyone can read, through the platform's egress checker. Its Connection lists
// the hosts it may read; it has no operations, so no agent, App or Workflow calls it.

/** The product token of the user agent, which `robots.txt` groups name. */
export const WEB_SOURCE_PRODUCT_TOKEN = "Catalyst-Knowledge";

export interface WebConnectorOptions {
  /** The instance's own address, which the user agent names so a site's operator can reach it. */
  instanceUrl?: string;
  /** A test's transport; the pinned, verified HTTPS transport unless given. */
  transport?: SourceHttpTransport;
  now?: () => number;
}

function firstTarget(settings: JsonObject) {
  const parsed = webSettingsSchema.safeParse(settings);
  const host = parsed.success ? parsed.data.hosts[0] : undefined;
  if (!host) throw connectionCallError("connection_not_configured");
  const url = new URL(`https://${host}/`);
  return {
    protocol: "https" as const,
    host: url.hostname,
    port: url.port === "" ? 443 : Number(url.port)
  };
}

export function createWebConnectorType(options: WebConnectorOptions = {}): ConnectorTypeDefinition {
  const deps = {
    transport: options.transport ?? sourceHttpTransport,
    userAgent: `${WEB_SOURCE_PRODUCT_TOKEN}/1.0${options.instanceUrl ? ` (+${options.instanceUrl})` : ""}`,
    productToken: WEB_SOURCE_PRODUCT_TOKEN,
    now: options.now ?? Date.now
  };
  return {
    type: WEB_CONNECTOR_TYPE,
    description: "Public web pages of the hosts it lists, as a synced Knowledge Base source.",
    settingsSchema: webSettingsSchema,
    authSchemes: ["none"],
    secretFields: [],
    catalog: [],
    // The first listed host. Every other one is checked by the egress checker when it is read.
    target: firstTarget,
    limits: { callTimeoutMs: 45_000, resultMaxBytes: 2 * 1024 * 1024, maxParallelCalls: 4 },
    documentSource: createWebSource(deps),
    form: {
      title: { en: "Web pages", de: "Webseiten" },
      description: {
        en: "Public pages of the hosts you list, kept current in a Knowledge Base.",
        de: "Öffentliche Seiten der Hosts, die du nennst, aktuell gehalten in einer Wissensbasis."
      },
      authScheme: "none",
      fields: [
        {
          setting: "hosts",
          label: { en: "Hosts", de: "Hosts" },
          help: {
            en: "The hosts it may read, separated by spaces, such as www.example.org docs.example.org",
            de: "Die Hosts, die gelesen werden dürfen, durch Leerzeichen getrennt, etwa www.example.org docs.example.org"
          }
        }
      ]
    },
    // Reads robots.txt of the first host; changes nothing.
    async test(context) {
      const settings = webSettingsSchema.safeParse(context.connection.settings);
      const host = settings.success ? settings.data.hosts[0] : undefined;
      if (!settings.success || !host) return { status: "unavailable" };
      try {
        const response = await createWebSession(context, settings.data, deps).get(
          new URL(`https://${host}/robots.txt`)
        );
        response.body.close();
        return { status: response.status < 500 ? "ready" : "unavailable" };
      } catch (error) {
        // A host whose robots.txt keeps everyone out still answered.
        if (error instanceof WebRefusal && error.reason === "robots") return { status: "ready" };
        if (error instanceof WebRefusal || error instanceof DocumentSourceError)
          return { status: "unavailable" };
        throw error;
      }
    },
    async execute() {
      throw connectionCallError("operation_unknown");
    }
  };
}
