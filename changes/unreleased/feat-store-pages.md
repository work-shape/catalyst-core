---
section: Changed
---

- **Data Stores:** Dependency reads name live agents carrying a store's row tools, and the store list includes visible Apps that use each store. Hidden dependencies stay unnamed.
- **Knowledge Bases:** The state read names visible live agents assigned to a Knowledge Base. The first document page includes the total retained documents, last successful ingestion and ingestion state.
- **Store pages:** Later Data Store drafts can be published from the live page, with the pending migration SQL shown before confirmation. Data Store deletion names the store in its confirmation. Data Store and Knowledge Base heads open the agent beside the page with starters for that kind; Knowledge Base pages show assigned agents and additional use rights, and their list shows documents, last ingestion and ingestion state in English and German.
- **Data Store deletion:** A published App, Workflow or Knowledge Base reference, or a live agent reference now refuses deletion with “This data store is still used. Remove its references before deleting it.” The check pages through all live references and rolls back the attempted removal. An unreferenced standalone store still uses the existing retirement behavior: its database remains until removed by the operator. No database migration is required.
- **Agent row-tool assignments:** Well-formed Data Store tool names pass static release validation and are checked against the live operation source. Missing and malformed tools remain refused.
