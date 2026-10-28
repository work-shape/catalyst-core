---
section: Added
---

- **Studio:** An agent page has a "Data" / "Daten" section. It gives the agent Data Stores to "read" / "lesen" or to "read and change" / "lesen und ändern", and saves them as the store's existing row tools in the agent's tool list (`data_store.<store>.describe`, `.query` and `.preview_rows`, plus `.insert`, `.update` and `.delete_rows`). The runtime is unchanged. A store the agent cannot use, such as the reader's own for an agent of everyone or a team's for an agent of another place, is greyed with the reason. One line says that every call still checks the rights of the person in the chat. These tools no longer show by their names under Tools.
- **Studio:** An agent page's head says where a chat can choose the agent: "Can be chosen in: All workspaces" / "Wählbar in: Alle Arbeitsbereiche" or the workspaces it is offered in. Where none can, it says "Cannot be chosen in any chat" / "In keinem Chat wählbar" and, for a reader who may change that, links to the "Available in" section. This replaces "Offered nowhere yet".
