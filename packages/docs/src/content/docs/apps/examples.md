---
title: App examples
description: Two whole Apps that build as they stand, a React dashboard with an action of each kind and a plain HTML App with one action on a Connection, to copy and adapt.
---

Part of [Build an App](/apps/build/). Each kind of action has its own page: [on a Connection](/apps/connection-actions/), [on a Data Store](/apps/data-store-actions/) and [starting a Workflow](/apps/workflow-actions/).

## A complete example

A dashboard for one client of an accounting data source: it reads bookings from the Connection `accounting_source`, lists findings kept in the Data Store `findings`, adds a finding and starts the Workflow `monthly-check`. Replace the names of the Connection, its operation, the Data Store and the Workflow with those of the instance, and the mapping with the input the operation declares.

```yaml title="app.yaml"
id: accounting-dashboard
name: Accounting dashboard
kit: 1.8.0
connections:
  - accounting_source
dataStores:
  - name: findings
actions:
  - { name: list-findings, file: actions/list-findings.sql, effect: reading }
  - { name: add-finding, file: actions/add-finding.sql, effect: changing }
```

```yaml title="actions/load-bookings.action.yaml"
connection: accounting_source
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
id: accounting-bookings
name: Accounting bookings
kit: 1.8.0
entry: index.html
connections:
  - accounting_source
```

```yaml title="actions/load-bookings.action.yaml"
connection: accounting_source
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
    <title>Accounting bookings</title>
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
