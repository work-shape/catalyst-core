---
section: Fixed
---

- **API keys:** Confirming a CLI's connect code and the New key form offer only the rights the person holds, everywhere or in the chosen workspace, and no longer list every action of the instance. A connect code's key starts with all of them ticked except deleting, `connection.use`, the instance level and the account level: a local agent holds that key, so deleting stays a deliberate tick. A Builder and Publisher of one workspace confirms as it stands and gets a key instead of a refusal. "Select all" and "None" tick or untick the list at once. `platform.context.get` now names deleting rights among `authoringActions` and the use level a key may carry per workspace (`workspaces[].useActions`).
