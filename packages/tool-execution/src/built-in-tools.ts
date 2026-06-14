import { z } from "zod";
import postgres from "postgres";
import { createPlatformId, type DataSourceConfig } from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

const lucideBootstrapScript =
  'document.addEventListener("DOMContentLoaded",function(){if(window.lucide){window.lucide.createIcons();}});';
const visualizationContentSecurityPolicy = [
  "default-src 'none'",
  "script-src https://cdn.tailwindcss.com https://unpkg.com 'unsafe-eval' 'sha256-6V/TXttL4T6O1ic9V4Qr2TeTi2T/kaP+KRIwPzbDt6M='",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
const visualizationRuntimeHead = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<meta http-equiv="Content-Security-Policy" content="${visualizationContentSecurityPolicy}">`,
  '<script src="https://cdn.tailwindcss.com"></script>',
  '<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>',
  `<script>${lucideBootstrapScript}</script>`
].join("\n");

const renderHtmlInputSchema = z.object({
  html: z.string().min(1).max(200_000),
  mode: z.enum(["inline", "side_panel", "fullscreen"]).default("inline"),
  title: z.string().min(1).max(160).optional()
});

const renderHtmlOutputSchema = z.object({
  displayed: z.literal(true),
  displayId: z.string(),
  mode: z.enum(["inline", "side_panel", "fullscreen"])
});

export interface BuiltInToolDefinitionOptions {
  dataSources?: Record<string, DataSourceConfig>;
  env?: Record<string, string | undefined>;
}

export function createBuiltInToolDefinitions(options: BuiltInToolDefinitionOptions = {}): AnyToolDefinition[] {
  return [
    renderHtmlTool,
    ...Object.entries(options.dataSources ?? {}).flatMap(([sourceName, source]) =>
      createDataSourceRenderViewTool(sourceName, source, options.env ?? {})
    )
  ];
}

export const renderHtmlTool = defineTool({
  name: "renderHtml",
  description:
    "Render model-authored HTML for the user as a visual display. Use this when a table, widget, chart, dashboard, or richer visual explanation would help. Tailwind CSS and Lucide icons are available in the rendered iframe.",
  inputSchema: renderHtmlInputSchema,
  outputSchema: renderHtmlOutputSchema,
  inputJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["html"],
    properties: {
      html: {
        type: "string",
        minLength: 1,
        maxLength: 200000,
        description:
          'Complete standalone HTML fragment or document to render for the user. Use Tailwind utility classes for styling and Lucide icons with elements such as <i data-lucide="chart-column"></i>.'
      },
      mode: {
        type: "string",
        enum: ["inline", "side_panel", "fullscreen"],
        default: "inline",
        description: "How prominently the user interface should render the HTML."
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description: "Optional short title for the rendered display."
      }
    }
  },
  async execute(input) {
    const displayId = createPlatformId<"ToolDisplayId">("display");
    const output = {
      displayed: true as const,
      displayId,
      mode: input.mode
    };
    return toolSuccess(output, {
      display: {
        kind: "html.rendered",
        version: 1,
        mode: input.mode,
        displayId,
        data: {
          html: prepareVisualizationHtml(input.html),
          ...(input.title ? { title: input.title } : {})
        }
      },
      auditSummary: {
        action: "renderHtml",
        subject: displayId,
        metadata: {
          mode: input.mode,
          htmlLength: input.html.length
        }
      }
    });
  }
});

function createDataSourceRenderViewTool(
  sourceName: string,
  source: DataSourceConfig,
  env: Record<string, string | undefined>
): AnyToolDefinition[] {
  const renderView = source.tools?.renderView;
  if (!renderView?.enabled) {
    return [];
  }
  const databaseUrl = resolveConnectionRef(source.connectionRef, env);
  const allowedSearchPath = createAllowedSearchPath(source.sql.allowedSchemas);
  const toolName = renderView.name ?? `data.${sourceName}.render_view`;
  const inputSchema = z.object({
    query: z.string().min(1).max(20000),
    htmlTemplate: z.string().min(1).max(200000),
    mode: z.enum(["inline", "side_panel", "fullscreen"]).default("side_panel"),
    title: z.string().min(1).max(160).optional()
  });
  const outputSchema = z.object({
    displayed: z.literal(true),
    displayId: z.string(),
    mode: z.enum(["inline", "side_panel", "fullscreen"])
  });

  return [
    defineTool({
      name: toolName,
      description: [
        `Render a private data view from ${source.description}.`,
        "The query result is rendered for the user but is not returned to the model.",
        source.sql.allowedSchemas.length > 0
          ? `Unqualified table names resolve through these configured schemas: ${source.sql.allowedSchemas.join(", ")}.`
          : "",
        source.sql.schemaDescription ? `Allowed query surface: ${source.sql.schemaDescription}` : ""
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema,
      outputSchema,
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query", "htmlTemplate"],
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 20000,
            description: "Read-only SQL query for the configured data source."
          },
          htmlTemplate: {
            type: "string",
            minLength: 1,
            maxLength: 200000,
            description:
              'HTML template to hydrate with private rows. Use {{DATA_JSON}} or {{ROWS_JSON}} where JSON data should be inserted. Tailwind CSS and Lucide icons are available in the rendered iframe; use <i data-lucide="..."></i> for icons.'
          },
          mode: {
            type: "string",
            enum: ["inline", "side_panel", "fullscreen"],
            default: "side_panel"
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 160
          }
        }
      },
      async execute(input) {
        assertReadOnlyQuery(input.query);
        const sql = postgres(databaseUrl, {
          max: 1,
          connect_timeout: Math.max(1, Math.ceil(source.sql.statementTimeoutMs / 1000)),
          idle_timeout: 1
        });
        try {
          await sql`set statement_timeout = ${source.sql.statementTimeoutMs}`;
          if (allowedSearchPath) {
            // Configured schemas guide unqualified lookup. Hard isolation must come from
            // the read-only database role and grants behind the connectionRef.
            await sql.unsafe(`set search_path to ${allowedSearchPath}`);
          }
          const rows = await sql.unsafe(input.query);
          const limitedRows = rows.slice(0, source.sql.maxRows);
          const displayId = createPlatformId<"ToolDisplayId">("display");
          const html = prepareVisualizationHtml(hydrateHtmlTemplate(input.htmlTemplate, {
            rows: limitedRows,
            truncated: rows.length > limitedRows.length
          }));
          const output = {
            displayed: true as const,
            displayId,
            mode: input.mode
          };
          return toolSuccess(output, {
            privateOutput: {
              rows: limitedRows,
              truncated: rows.length > limitedRows.length
            },
            display: {
              kind: "private_hydrated_view",
              version: 1,
              mode: input.mode,
              displayId,
              data: {
                html,
                ...(input.title ? { title: input.title } : {})
              }
            },
            auditSummary: {
              action: toolName,
              subject: sourceName,
              metadata: {
                modelVisibleOutput: "zero_data_ack"
              }
            }
          });
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    })
  ];
}

function resolveConnectionRef(ref: string, env: Record<string, string | undefined>): string {
  const envPrefix = "env:";
  if (!ref.startsWith(envPrefix)) {
    throw new Error("Only env: data source connection references are supported in v1");
  }
  const envName = ref.slice(envPrefix.length);
  const value = env[envName];
  if (!value) {
    throw new Error(`Missing data source connection secret '${envName}'`);
  }
  return value;
}

function assertReadOnlyQuery(query: string): void {
  const normalized = query.trim().replace(/;+$/u, "").trim();
  if (!/^(select|with)\b/iu.test(normalized)) {
    throw new Error("Private render-view queries must be read-only SELECT or WITH statements");
  }
  if (/;\s*\S/u.test(normalized)) {
    throw new Error("Private render-view queries must contain a single statement");
  }
}

function createAllowedSearchPath(allowedSchemas: readonly string[]): string | undefined {
  if (allowedSchemas.length === 0) {
    return undefined;
  }
  return allowedSchemas.map(quotePostgresIdentifier).join(", ");
}

function quotePostgresIdentifier(identifier: string): string {
  if (identifier.includes("\u0000")) {
    throw new Error("Postgres schema names must not contain null bytes");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function prepareVisualizationHtml(html: string): string {
  if (/<html(?:\s|>)/iu.test(html)) {
    if (/<\/head>/iu.test(html)) {
      return html.replace(/<\/head>/iu, `${visualizationRuntimeHead}\n</head>`);
    }
    return html.replace(/<html([^>]*)>/iu, `<html$1><head>${visualizationRuntimeHead}</head>`);
  }
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    visualizationRuntimeHead,
    "</head>",
    '<body class="bg-white text-slate-950 antialiased">',
    html,
    "</body>",
    "</html>"
  ].join("\n");
}

function hydrateHtmlTemplate(template: string, data: unknown): string {
  const json = JSON.stringify(data).replaceAll("</script", "<\\/script");
  if (template.includes("{{DATA_JSON}}") || template.includes("{{ROWS_JSON}}")) {
    return template.replaceAll("{{DATA_JSON}}", json).replaceAll("{{ROWS_JSON}}", json);
  }
  return `${template}\n<script type="application/json" id="vivd-private-data">${json}</script>`;
}
