# open_invoices: an example code tool

A code tool in Python, to copy when you write your own. It looks up one customer of the demo's sample business system through the Connection `sample-business`, sums the customer's unpaid invoices, answers the model with one sentence and shows the invoices beside the chat.

## The folder

```text
open_invoices/
  tool.yaml   title and summary (en, de), icon, the Connection operations it calls, timeout
  main.py     the handler: one @tool function
  README.md   this file
```

`main.py` holds one function marked `@tool`. The CLI reads the tool's name from the function, the description from the docstring and the input schema from the type hints: `customer_id: str` is required, and `overdue_only: bool = False` is optional because it has a default. The `Args:` section describes each parameter for the model.

The function gets `ctx` first:

- `ctx.connection("sample-business").call("get_customer", {"id": ...})` calls a Connection operation. `tool.yaml` must declare it under `connections`; a call it does not declare is refused. An MCP Connection answers `{ content, structuredContent }`.
- `ctx.display.data(kind, data, title)` shows data beside the chat. Without a widget for the kind, the generic data view draws it: plain values as labelled rows, a list of flat objects as a table.
- `ctx.log(...)` writes to the log, never to the model.

What the function returns is what the model reads.

## Run it locally

Run the commands from `clients/demo`, whose `catalyst.yaml` names the local demo instance, or add `--instance <url>`. Sign in first with `catalyst login`, or set `CATALYST_API_KEY`, as a person who may use the Connection `sample-business`.

```sh
catalyst tool run tools/code/open_invoices --input '{"customer_id":"C-0001"}'
```

It prints what the model would read on stdout, and the handler's log and the path of a page with the display on stderr:

```text
"Velunara Fenvilo GmbH has 20 unpaid invoices over 31722.55 EUR, 28960.60 EUR of it overdue. The oldest was due on 2025-12-05. The invoices are shown beside the chat."
C-0001: 20 unpaid invoices
The handler showed a display: open /var/folders/…/catalyst-tool-display-…/display.html in a browser.
```

The amounts depend on the month the sample server started in. `--json` prints the whole answer: `output`, `display` and `simulatedCalls`.

A local Connection call is a Try call: the CLI sends it to the instance with your key, and the instance makes it with the Connection's test credential where it has one. Without one, a reading call such as `get_customer` goes to the live system, and a changing call is simulated: nothing changes, and stderr names the simulated call. The operation must be exposed to outside clients (`exposure: [..., outside]`); the demo's `config/app.yaml` does that for `get_customer`.

## Write it to the instance

```sh
catalyst tool put tools/code/open_invoices
```

This writes the folder as the tool's next draft, revision `<n>`, and prints the publish command. Then make the draft callable:

```sh
catalyst tool publish open_invoices --revision <n>
```

## Give it to an agent

A published tool is the operation `tool.open_invoices.call`. Add it to the agent's `toolNames`, for example in `clients/demo/agents/workflow-assistant.agent.yaml`:

```yaml
toolNames:
  - tool.open_invoices.call
```

Then push the agent (`pnpm config:push` in `clients/demo`). An agent can name only a tool that exists, so put and publish the tool first. The person who talks to the agent needs the right to use `sample-business`.

`catalyst tool put` and `catalyst tool run` execute this code on your computer, as you, outside any sandbox: run them only on code you trust.
