# Packaging And Repository Strategy

The product should use a code-deployed model with reusable platform packages imported by thin client assembly apps. Customer-specific code should sit on top of the platform, not fork or copy the platform.

## Core Shape

```text
platform packages
  @product/core
  @product/api-contract
  @product/api-client
  @product/chat-server
  @product/chat-widget
  @product/chat-standalone
  @product/chat-ui
  @product/agent-runtime
  @product/usage-governance
  @product/tool-execution
  @product/tool-sdk
  @product/config-schema
  @product/retrieval

client assembly app
  imports platform packages
  defines client tools
  defines agent YAML/config
  defines UI/domain-output config
  defines deployment env/compose wiring
```

The client layer should be intentionally thin. It should contain customer-specific tools, agent definitions, config, branding, domain UI output definitions, and deployment wiring. It should not contain copied platform internals.

## Code-Deployed Model

The client instance is built from source-controlled code and configuration. Custom tools live as source files or packages, agent configs reference them by stable names, and deployment rebuilds or reloads the instance.

The repository remains the source of truth. A CLI can validate, test tools, build, publish, or trigger deployment, but it should not register agents/tools by mutating a running instance.

## Config Source Of Truth

V1 should use release config only.

Release config is version-controlled and deployed with the client assembly app. It defines agent behavior, tool availability, OpenAPI operation selections, built-in tool enablement, model provider options, domain UI output types, retention policy, usage budget, usage safeguards, client branding/theme, and default policy bounds.

Release config changes through the normal release/publish/deploy flow. The platform should snapshot the active release config at deploy/startup so runtime behavior is explainable.

The v1 control plane may display active config and config snapshots, but it should not edit agent behavior, tool availability, model providers, UI settings, or retention policy at runtime.

Future runtime governance settings may be added later for low-risk values such as maintenance flags, active model from a release-config allowlist, or retention duration within release-config bounds. Runtime settings must not introduce new tools, agents, OpenAPI operations, model providers, or arbitrary code.

## Tool Registry

A registry is the mapping between stable tool names and executable implementations plus metadata. It does not have to mean a central database. For v1 it should be created at build/startup from explicit code exports and release config.

Tool pipeline:

```text
tool source adapters
  -> tool definitions
  -> tool registry
  -> agent config tool allowlist
  -> tool execution interface
  -> in-process executor or tool worker
```

For custom code tools, the customer/client assembly app should explicitly import or export the tool files that belong to the instance. Avoid production behavior that auto-loads arbitrary files from a folder without validation.

Example:

```ts
import { defineTool } from "@product/tool-sdk";

export default defineTool({
  name: "payslip.summarize",
  inputSchema,
  async execute(input, context) {
    // customer-specific implementation
  },
});
```

## Client Assembly App

Recommended client instance shape:

```text
client-assembly/
  package.json
  docker-compose.yml
  Dockerfile
  .env.example
  src/
    server.ts
    tool-registry.ts
    config.ts
    domain-ui.ts
  agents/
    payslip-agent.yaml
    instructions/          # optional; instructions may also live inline in YAML
      payslip-agent.md
  tools/
    payslip-summary.ts
    lookup-employee.ts
  config/
    app.yaml
    ui.yaml
    model-providers.yaml
  deploy/
    compose.prod.yaml
    Caddyfile
```

Imports happen in the client assembly app at build time. The deployed image contains the selected versions of platform packages plus that client's tools, agents, config, and server wiring.

```ts
import { createChatServer } from "@product/chat-server";
import { tools } from "./tool-registry";
import { loadClientConfig } from "./config";

const config = await loadClientConfig();

createChatServer({
  config,
  tools,
}).listen();
```

The platform assembly should validate the closure between release config and code before listening:

- every agent tool reference must exist in release config
- every enabled configured tool must have a registered implementation
- disabled tools must not appear in an agent allowlist
- v1 must reject enabled `approval_required` tools until the runtime supports resume

This keeps the client assembly app thin while making code-deployed configuration failures explicit at startup.

Tool code imports only the public tool SDK and product-owned types:

```ts
import { defineTool } from "@product/tool-sdk";

export const summarizePayslip = defineTool({
  name: "payslip.summarize",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    // customer-specific implementation
  },
});
```

Agent config references stable tool names, not file paths:

```yaml
agents:
  payslip_agent:
    instructions: |
      You are the payslip assistant for this client instance.
    tools:
      - payslip.summarize
```

Longer instructions may be moved into a separate Markdown file and referenced from YAML when that improves readability.

Usage and branding config are part of the same release-config contract:

```yaml
usage:
  budget:
    monthlySpendLimit: 200
    costSafetyMultiplier: 1.3
  safeguards:
    modelCallsPerDay: 1000
    tokensPerDay: 2500000
    tokensPerMonth: 50000000
  pricing:
    currency: USD
    models:
      - providerId: openai
        model: gpt-4.1
        inputPricePerMillionTokens: 2
        outputPricePerMillionTokens: 8
ui:
  clientName: Example Customer
  logoUrl: https://example.com/logo.png
  theme:
    accentColor: "#0f766e"
    backgroundColor: "#f5f3ee"
    surfaceColor: "#fffdfa"
```

## Package Split

Suggested initial monorepo shape:

```text
packages/
  core/
  api-contract/
  api-client/
  chat-server/
  chat-ui/
  chat-widget/
  chat-standalone/
  agent-runtime/
  usage-governance/
  tool-execution/
  config-schema/
  tool-sdk/
  retrieval/
clients/
  first-customer/
    agents/
    tools/
    config/
    src/
```

Submodules should be avoided at the beginning. They add operational friction, make local development and CI more brittle, and do not solve the central design question. Once platform boundaries stabilize, platform packages can be published or moved into a separate repo without making the first implementation pay that cost early.

## Package Ownership Over Time

During early development, platform packages and the first client assembly app may live in one monorepo for speed:

```text
packages/   # reusable platform code
clients/    # thin client assembly apps
```

Long term, platform packages should be versioned and imported externally by client projects:

```json
{
  "dependencies": {
    "@product/chat-server": "1.4.2",
    "@product/chat-widget": "1.4.2",
    "@product/tool-sdk": "1.4.2",
    "@product/config-schema": "1.4.2"
  }
}
```

A customer/self-hosted repo should eventually contain only the client assembly app:

```text
customer-chat/
  package.json
  Dockerfile
  docker-compose.yml
  src/
    server.ts
    tool-registry.ts
    domain-ui.ts
  agents/
  tools/
  config/
  deploy/
```

This keeps platform updates possible: the customer/client project upgrades package versions and rebuilds its client-specific image instead of merging changes from a copied starter repo.

## Image Strategies

- **Client-specific image**: preferred first approach. The client app builds its own image using platform packages.
- **Platform base image**: useful later. The client build extends a base image and adds its tools/config.
- **Pure ready-made image**: useful only for config-only clients or external API tools; insufficient for first-class custom code tools.

The key requirement is that the deployed instance is reproducible from version-controlled inputs.

## CLI Role

CLI commands should support the code-deployed model:

- validate config
- test tools locally
- generate API clients
- build packages/images
- publish release tags
- deploy a selected release

CLI commands should not add, remove, or update agents/tools inside a running production instance.
