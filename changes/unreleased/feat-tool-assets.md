---
section: Added
---

- **Tools as assets (TOOL-1):** an instance adds a tool without a release. A tool asset of type
  `result` declares an input JSON Schema and a display kind; `catalyst tool put` writes its draft
  and `catalyst tool publish` makes it live as the operation `tool.<name>.call`, which agents list
  in `toolNames`. A call checks the agent's input against the schema and writes it as the
  conversation's structured result, which the panel draws with the release's widget for that
  kind. It holds no code and reaches nothing outside the conversation. New rights `tool.read`,
  `tool.write`, `tool.publish`, `tool.approve` and `tool.delete`; Studio lists tools under
  "Werkzeuge".
