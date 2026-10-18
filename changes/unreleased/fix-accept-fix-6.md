---
section: Fixed
---

- Workflow tests no longer queue or deliver failure notices, including jobs left by older workers. Published failures still notify their publisher.
- Workflow account discovery excludes release and integration accounts and accounts whose rights the publisher cannot lend. The authoring agent chooses the sole suitable account and offers the publish confirmation.
- Scheduled Workflows retain their time zone, default to the instance zone (UTC when unset), and name it in schedule and publish text. The demo uses Europe/Berlin.
- Publish details follow the current triggers, and a refused Connection step names its account and Connection with a direct next step for administrators.
