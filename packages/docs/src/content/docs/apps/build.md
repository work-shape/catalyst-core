---
title: Build an App
description: How an agent writes a Page, saves it as an App and gives it named actions on a Connection, a Data Store or a Workflow, and how the App's code calls them.
---

An App is a Page that is kept. An agent writes the Page's files in its execution workspace, saves the folder with `page.save` and shows it beside the conversation. When the person asks to keep it, `page.save_as_app` makes it an App with a draft. A person publishes the draft; an agent never publishes.

A quick Page may show data the agent wrote into it. Live data comes through named actions: one file per action in the folder `actions/`, which the build compiles into the manifest. The browser calls an action by its name and nothing else: it never calls a Connection, a Data Store or a Workflow directly, and it never holds a key.

## The folder

```text
<folder>/
  app.yaml                    the manifest
  index.html                  a plain HTML App: its entry
  src/routes/__root.tsx       a React App: TanStack Router file routes
  src/routes/index.tsx
  src/components/*.tsx        optional
  actions/<name>.action.yaml  a call of a Connection's operation, or the start of a Workflow
  actions/<name>.sql          a statement on the App's Data Store
  assets/                     images and other static files
```

Write the files with the workspace file tools, then save the folder with `page.save`, giving the Page a name and the folder that holds `app.yaml`. A save builds the Page. It answers the revision, or the build errors with file and line: fix the files and save again. After `page.save_as_app`, each later `page.save` of the same Page name writes the App's next draft, so keep working in the same folder.

A React App imports only its own files, `react`, `react-dom`, `@tanstack/react-router` and `@work-shape/catalyst-app-kit`. Nothing is installed. A plain HTML App names `entry: index.html`; inline scripts work, inline event handler attributes such as `onclick` do not.

## The manifest

`app.yaml` names everything the App reaches. A Connection or a Data Store that the manifest does not list cannot be called.

| Key | What it holds |
| --- | --- |
| `id` | Lowercase letters, digits and `-`, at most 63 characters. |
| `name` | The name people read. |
| `description`, `icon` | Optional. |
| `kit` | The exact kit version. Use `1.3.0` for a new App; actions on a Connection need `1.1.0` or later and `workflow` actions `1.3.0` or later. |
| `entry` | `index.html` for a plain HTML App. A React App leaves it out. |
| `connections` | The Connections the App's actions call, by name. |
| `dataStores` | The Data Store the App's `sql` actions use: `{ name, minSchema }`. One at most while the App has `sql` actions. |
| `actions` | One line per `sql` action: `{ name, file, effect }`. Optional for the other kinds. |
| `externalHosts` | Internet hosts the browser code may fetch from, such as `api.example.com`. |

Any other key is refused. `pages` is derived from `src/routes/` and is not written by hand.

## Named actions

An action's name is the name of its file without the ending: `actions/load-bookings.action.yaml` is the action `load-bookings`. A name has lowercase letters, digits, `-` and `_`.

| Kind | File | Reaches | Effect |
| --- | --- | --- | --- |
| `connection` | `actions/<name>.action.yaml` with `connection`, `operation`, `effect` | One operation of a Connection the manifest lists | Written in the file |
| `sql` | `actions/<name>.sql` plus a line under `actions` in `app.yaml` | The Data Store the manifest lists | Written in the manifest line |
| `workflow` | `actions/<name>.action.yaml` with `workflow` | A run of the published Workflow | Always `changing` |

Every call runs as the person who looks at the App, through the platform's policy and audit. In the published App the viewer needs the right to use the App; in its draft, the right to write it. Beside that, for a `connection` action the viewer needs the right to use the Connection, for a `workflow` action the right to use the Workflow. An `sql` action of a published App needs no right on the Data Store: the person who published the App answered for it.

Server code of an App's own, beyond these three kinds, is planned and not available.

### A `connection` action

```yaml
connection: exampledata
operation: list_bookings
effect: reading
description: The bookings of one client in one month.
input:
  schema:
    type: object
    properties:
      client: { type: string, maxLength: 40 }
      month: { type: string, description: "The month as YYYY-MM" }
    required: [client]
  mapping:
    clientId: "{{client}}"
    period: "{{month}}"
```

- `connection` is the Connection's name, which `connections` in `app.yaml` lists.
- `operation` is the name of one operation of that Connection, exactly as the Connection lists it. For an MCP Connection that is the name of the server's tool. Only an operation an editor accepted on the Connection's page, enabled and offered to Apps (exposure `bridge`), can be called. `platform.assets.operations` with `for: app` lists the operations an App may call, as far as the person may use them, each named `connection.<connection>.<operation>` with its effect: write the two parts as `connection` and `operation`. `platform.assets.get` on the Connection shows all its accepted operations with name, effect and exposure, where the person may read the Connection. Without these tools, ask the person for the operation's name.
- `effect` is `reading` or `changing`, as the operation was accepted. A `reading` action that stands for a changing operation is refused.
- `input.schema` declares the parameters the browser passes: JSON Schema with `type: object` and `properties` of type `string`, `integer`, `number`, `boolean` or `array` of one of them. A parameter not declared is refused at the call.
- `input.mapping` is the operation's input. A value `"{{name}}"` stands for the parameter `name`; every other value is passed as written. A mapping computes nothing: a text that holds `{{` other than as the whole value is refused by the build. A parameter the caller leaves out leaves out its key.

The answer's `result` is the MCP tool's result: `{ content, structuredContent }`, where `content` is a list of blocks such as `{ type: "text", text }` and `structuredContent` is there when the tool gives one. A tool that answers an error rejects the call.

### An `sql` action

The statement is one file. Its first lines declare the parameters, and the statement names each as `$name`:

```sql
-- @param client text optional
select id, client_id, title, created_at
from findings
where $client is null or client_id = $client
order by created_at desc
limit 100
```

The manifest says what the statement does, with one line for it:

```yaml
actions:
  - { name: list-findings, file: actions/list-findings.sql, effect: reading }
```

- A parameter line is `-- @param <name> <type>`, with `optional` after it where a call may leave it out. A type is `text`, `integer`, `number`, `boolean`, `date` or `timestamp`, or one of them followed by `[]` for a list.
- A `reading` statement is one `SELECT` or `WITH`.
- A `changing` statement is one `INSERT` of one row whose values are all parameters, with `on conflict do nothing` after it where an existing row is skipped. An `UPDATE` or a `DELETE` is not available yet.
- A value is bound to its place in the statement and never written into it.

A reading statement answers `{ columns, rows, truncated }`: `rows` is a list of objects by column name, at most 1,000 rows and 2 MiB, and `truncated` says the result was cut; page with `limit` and `offset` parameters. A `numeric` value comes as text. An insert answers `{ table, inserted, skipped }`.

### The Data Store

The App lists its Data Store under `dataStores` in `app.yaml`, by name, with `minSchema` where it needs at least that migration of the store. The `dataStores` module has to be on. The agent cannot create a Data Store or its tables: a person creates it with its migrations (`store.yaml` and `migrations/0001_<name>.sql`, written with `catalyst data-store put` and published), and the statements read and write the tables those migrations made. Ask the person which Data Store to use, or to create one.

An `sql` action runs only in an App: in a Page a reading `sql` action is refused with `data_store_needs_app`, and a changing one with `draft_safe_mode`. In the App's draft it runs with the viewer's own right on the store: to read it, and for an insert, which the draft simulates, to insert.

### A `workflow` action

```yaml
workflow: monthly-check
description: Checks the bookings of one client.
input:
  schema:
    type: object
    properties:
      client: { type: string }
    required: [client]
  mapping:
    client: "{{client}}"
```

`workflow` is the Workflow's name. The mapping makes the input the Workflow declares. The call starts a run of the Workflow's published revision as the viewer, who needs the right to use that Workflow. The answer's `result` is the Workflow Run; follow it with `useWorkflowRun(result.id)` from the kit, or `workflowRuns.get(result.id)` in a plain HTML App. A `workflow` action has no `effect` key and no `connection`; it needs kit `1.3.0` or later.

## Effects, drafts and publishing

A `reading` action runs live everywhere, with the viewer's rights. A `changing` action is carried out only in the published App; before that it runs in safe mode:

- In the draft of an App, a `changing` action of each kind is simulated. It changes nothing and answers `{ status: "dry_run", message, result }`: `message` says what the call would have done, and whether live it would wait for another person's approval; `result` is the input it would have done it with. The call goes through the viewer's rights and the policy as a live call would, so a call that would be refused live is refused here too, and it leaves an Operation Run with the target `dry_run`. Show `message` as it is.
- "Run live once" on the App's Actions list carries out the next call of one changing action of the draft for real. A person who may write the App switches it on for themselves; it covers only their own next call of that action, and every save or discard of the draft clears a switch nobody used, so a `page.save` clears it too. A call it sends live that the policy holds for another person's approval is refused with `approval_unavailable`, since a draft cannot wait. An agent cannot switch it on: when the person wants to try a change for real, tell them where the switch is.
- In a Page that is not yet an App, a changing `connection` or `sql` action is refused with the code `draft_safe_mode`, and nothing is called. A `workflow` action answers `{ status: "dry_run", message, result }` as in a draft, but leaves no run.

A changing call passes `{ idempotencyKey }` in the draft as in the published App. The published App carries out every action. An action may ask for a stricter `policy` than the instance sets (`confirm`, `approval` or `deny`), written in the action file or, for an `sql` action, in its manifest line. A call that waits for another person's approval answers `status: "pending_approval"` without a result.

An agent never publishes. Tell the person to publish the draft: with the Publish button on the App's page, or with `catalyst app publish <name> --revision <n> --workspace <id>`. Publishing needs the right `app.publish`, which administrators hold. It checks again what a save checked, and that each Data Store is published, at `minSchema` or later, readable (for an insert, `data_store.insert`) by the person who publishes, and of the App's workspace; a retired store, or one of another workspace, is refused. Guardrails may answer the publish too.

Saving checks what it can: when a save writes the App's draft, it refuses a Connection that does not exist, a Data Store that does not exist, an operation the Connection does not accept and a `reading` action on a changing operation. `page.save` then answers the Page as saved and, under `app`, `saved: false` with what was found: fix it and save again. Whether the operation is enabled and offered to Apps (exposure `bridge`) is checked only at the call, which is refused as forbidden: check the operation's exposure on the Connection's page first.

## Calling an action from the App

Import `actions` from `@work-shape/catalyst-app-kit`. `actions.call(name, params, options)` calls a named action and answers `{ runId, status, result }`. `result` is what the action answered, as described for each kind above: check its shape before using it. A call that is refused or fails rejects with an `AppCallError`. Show its `message` as it is, since it is the platform's sentence in the viewer's language, and offer no button to try again when `retryable` is false.

A changing call passes `{ idempotencyKey }`: make the key when the person acts, and send the same key again when the answer was lost. In a draft the answer to a changing call is `{ status: "dry_run", message, result }` unless "Run live once" sent it live: show `message`, which says what the published App would have done.

`getContext()` answers the viewer, the locale and, under `can`, what the instance says for each action: `allow`, `confirm`, `approval` or `deny`. The server asks again at every call.

## A complete example

A dashboard of one ExampleData client: it reads bookings from the Connection `exampledata`, lists findings kept in the Data Store `findings`, adds a finding and starts the Workflow `monthly-check`. Replace the names of the Connection, its operation, the Data Store and the Workflow with those of the instance, and the mapping with the input the operation declares.

```yaml title="app.yaml"
id: exampledata-dashboard
name: ExampleData dashboard
kit: 1.3.0
connections:
  - exampledata
dataStores:
  - name: findings
actions:
  - { name: list-findings, file: actions/list-findings.sql, effect: reading }
  - { name: add-finding, file: actions/add-finding.sql, effect: changing }
```

```yaml title="actions/load-bookings.action.yaml"
connection: exampledata
operation: list_bookings
effect: reading
description: The bookings of one client in one month.
input:
  schema:
    type: object
    properties:
      client: { type: string, maxLength: 40 }
      month: { type: string, description: "The month as YYYY-MM" }
    required: [client]
  mapping:
    clientId: "{{client}}"
    period: "{{month}}"
```

```sql title="actions/list-findings.sql"
-- @param client text optional
select id, client_id, title, created_at
from findings
where $client is null or client_id = $client
order by created_at desc
limit 100
```

```sql title="actions/add-finding.sql"
-- @param client text
-- @param title text
insert into findings (client_id, title) values ($client, $title)
```

```yaml title="actions/run-check.action.yaml"
workflow: monthly-check
description: Checks the bookings of one client.
input:
  schema:
    type: object
    properties:
      client: { type: string }
    required: [client]
  mapping:
    client: "{{client}}"
```

```tsx title="src/routes/__root.tsx"
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({ component: () => <Outlet /> });
```

```tsx title="src/routes/index.tsx"
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppCallError, actions, useWorkflowRun } from "@work-shape/catalyst-app-kit";
import { Button } from "@work-shape/catalyst-app-kit/ui";

export const Route = createFileRoute("/")({ component: Dashboard });

const CLIENT = "10023";

/** A message to show for a failed call: the platform's own where it gave one. */
function messageOf(error: unknown): string {
  return error instanceof AppCallError ? error.message : "The call failed.";
}

function Dashboard() {
  const [bookings, setBookings] = useState<unknown>();
  const [findings, setFindings] = useState<unknown>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const { run } = useWorkflowRun(runId);

  const load = () => {
    actions
      .call("load-bookings", { client: CLIENT, month: "2026-09" })
      .then((answer) => setBookings("result" in answer ? answer.result : undefined))
      .catch((failure: unknown) => setError(messageOf(failure)));
    actions
      .call("list-findings", { client: CLIENT })
      .then((answer) => setFindings("result" in answer ? answer.result : undefined))
      .catch((failure: unknown) => setError(messageOf(failure)));
  };
  useEffect(load, []);

  const addFinding = () => {
    actions
      .call(
        "add-finding",
        { client: CLIENT, title: "Booking without receipt" },
        { idempotencyKey: `add-finding-${Date.now()}` }
      )
      .then((answer) => {
        // In the App's draft a change is simulated: say what it would have done.
        if (answer.status === "dry_run") setNote(answer.message);
        else load();
      })
      .catch((failure: unknown) => setError(messageOf(failure)));
  };

  const startCheck = () => {
    actions
      .call("run-check", { client: CLIENT }, { idempotencyKey: `run-check-${Date.now()}` })
      .then((answer) => {
        if (answer.status === "dry_run") {
          setNote(answer.message);
          return;
        }
        const started = answer.result;
        if (typeof started === "object" && started !== null && "id" in started) {
          setRunId(String(started.id));
        }
      })
      .catch((failure: unknown) => setError(messageOf(failure)));
  };

  return (
    <main>
      <h1>Client {CLIENT}</h1>
      {error ? <p role="alert">{error}</p> : null}
      {note ? <p role="status">{note}</p> : null}
      <Button onClick={addFinding}>Add finding</Button>
      <Button onClick={startCheck}>Run the monthly check</Button>
      {run ? <p>Check: {run.status}</p> : null}
      <pre>{JSON.stringify({ bookings, findings }, null, 2)}</pre>
    </main>
  );
}
```

## A plain HTML App

The same call from a plain HTML App, with one action on the Connection.

```yaml title="app.yaml"
id: exampledata-bookings
name: ExampleData bookings
kit: 1.3.0
entry: index.html
connections:
  - exampledata
```

```yaml title="actions/load-bookings.action.yaml"
connection: exampledata
operation: list_bookings
effect: reading
input:
  schema:
    type: object
    properties:
      client: { type: string }
    required: [client]
  mapping:
    clientId: "{{client}}"
```

```html title="index.html"
<!doctype html>
<html>
  <head>
    <title>ExampleData bookings</title>
  </head>
  <body>
    <h1>Bookings</h1>
    <p id="state">Loading…</p>
    <pre id="rows"></pre>
    <script type="module">
      import { actions, AppCallError } from "@work-shape/catalyst-app-kit";

      const state = document.getElementById("state");
      try {
        const answer = await actions.call("load-bookings", { client: "10023" });
        state.textContent = "";
        document.getElementById("rows").textContent = JSON.stringify(answer.result, null, 2);
      } catch (error) {
        state.textContent = error instanceof AppCallError ? error.message : "The call failed.";
      }
    </script>
  </body>
</html>
```

## When a save fails

The build answers each fault with its file and a sentence that names the fix. The common ones:

- `connection_not_declared`: the action calls a Connection that `connections` in `app.yaml` does not list.
- `data_store_not_declared`: an `sql` action and no `dataStores` in `app.yaml`.
- An `sql` file without its line under `actions`: add `{ name, file, effect }`.
- A YAML file in `actions/` without the ending `.action.yaml`: rename it.
- A missing `connection`, `operation` or `effect` in an action file: add it.
- `sql_statement_not_allowed`: a reading statement that is not one `SELECT` or `WITH`, or a changing one that is not one `INSERT` of parameters.

At a call, `action_unknown` means the manifest of the shown revision has no action of that name: save the Page again after adding the file.
