---
section: Added
---

- **CLI:** `catalyst models add azure|vertex|bedrock|openai-compatible` writes a model provider, a binding on it and its price into the release config of a deployment repository and names the one secret to set. It only adds lines, so comments and layout stay; it never asks for or writes a key, refuses a region other than `eu` with the reason, refuses a Bedrock profile of another account or region by the rule the instance applies at startup, and refuses a list that an environment file would take from the file it extends. `catalyst models check <id>` runs the instance's infrastructure check (`users.manage`) and prints the provider's state in the product's words, never a provider's text. `catalyst models list` shows the release config's providers, and with `--instance` what the instance reports. New docs page: "Use your own model provider".
- **Platform:** the rule for secret names and the rule for Bedrock application inference profiles moved into `@work-shape/catalyst-asset-schemas`, so the instance and the CLI apply the same one. No behaviour changed.
