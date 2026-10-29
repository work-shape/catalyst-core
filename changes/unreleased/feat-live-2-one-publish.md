---
section: Added
---

- **Workflows:** One Publish of a Workflow makes it live with the Data Stores its steps call (LIVE-2). The publish names each store at the reviewed revision (`dataStores`, as on an App's Publish); each store is published and its pending migrations applied first, then the Workflow's own account and grants are created or updated and the revision goes live. When a migration fails, nothing goes live and the refusal says the Workflow was not published (`publishing: "workflow"`). The read of a Workflow lists the stores the reader may publish with their pending migrations (`publishDataStores`), and the Workflow page's publish question names them above the account line. A store's own Publish is unchanged.
