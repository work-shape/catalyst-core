---
section: Added
---

- **Tools:** a code tool can be written as a folder: `tool.yaml` beside `main.py` with one
  `@tool` function (the platform's `catalyst_tools` module, standard library only) or `index.ts`
  that exports one `defineTool` from `@work-shape/catalyst-tool-sdk/code`. The input schema and
  the description come from the handler: Python type hints and the docstring, or the Zod schema.
  The handler gets `ctx` with `connection(name).call(...)`, `display.data(...)`,
  `display.html(...)` and `log(...)`.
- **CLI:** `catalyst tool put <folder>` derives the definition locally, bundles a TypeScript tool
  into one ES module and writes the next draft; `catalyst tool run <folder> --input <json>` runs
  the handler on this computer, and prints its output and the path of a page with its display.
  `run` checks `--input` against the tool's input schema and holds the handler to the sandbox's
  limits on its answer, display and requests; it names every simulated call on stderr and counts
  them in `--json`. An HTML display runs there in a frame without an origin that reaches no host.
  Both commands run the tool's code on your computer, as you, outside any sandbox.
- **Connections:** `connections.try_call` (`POST /api/v1/connections/{name}/operations/{operation}/tries`)
  calls a Connection operation as a draft's call: to the test credential where one is set, and
  simulated where a changing call has none. An operation that cannot be called now is refused,
  not simulated. `catalyst tool run` makes its handler's Connection
  calls with it; it needs `connection.use` and the operation's exposure to outside clients.
- **Tools:** a code tool's files may hold up to 1 MiB, each and together, so a bundled
  TypeScript tool fits.
