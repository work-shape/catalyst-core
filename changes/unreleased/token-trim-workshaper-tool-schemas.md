---
section: Changed
---

- **Agents:** the tool definitions a platform agent sends with every model request are about a third smaller: about 12,100 instead of 18,300 tokens for the Workshaper's tools in the demo, measured with o200k. Descriptions say each rule once, in the tool that needs it; prose that repeated the platform orientation or the docs is gone, and the plain-HTML styling notes of `workspace.open` moved to the App sandbox docs page. The tools, their order and what they accept are unchanged.
- **Tools:** the JSON Schema a model is shown leaves out what tells it nothing: a `pattern` beside a `format`, a minimum length or item count of one, a maximum length of 1,000 or more, the safe-integer bounds and string-only `propertyNames`. The tool's own schema still checks every call. `deriveInputJsonSchema` is exported from `@work-shape/catalyst-tool-sdk`, so a tool can show the model a narrower schema than the one it validates with.
- **Tools:** `mail.send` shows the model only the recipient forms an agent writes. `platform.connections.propose` shows one object instead of a union at the root of its input, which Anthropic models, also on Bedrock, refuse.
- **Agents:** the platform orientation no longer repeats how a Connection is proposed or drafted, how operations are paged or what the asset list answers; the tools that do it say so.
