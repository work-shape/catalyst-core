---
section: Fixed
---

- Keep normal multi-person agent use below the shipped runaway-loop safeguards, isolate personal usage from other people's safeguards, and retain instance-wide money budgets. Operators must review existing explicit safeguard overrides when upgrading; the release-config and capacity documentation describe the new defaults and scope. Older releases interpret explicit safeguard values as instance-wide and impose no safeguards when the block is omitted; restore the previous release config when rolling back.
- Show localized usage-limit notices with a next step, using the code `MODEL_USAGE_LIMIT_REACHED`, and label the Usage safeguards as per person.
- Explain refused Connections in EN/DE with who can change the configuration. Keep technical details in a collapsed section for instance admins.
- Ask before a Data Store is published, and show what the database server leaves open around a store only to a superadmin, as steps to take.
- Name generated conversation titles, the temporary title of a conversation started with files, and the agent's created and opened lines in the language of the account or run. Authored text such as skill descriptions and Workflow names stays as written.
- Studio opens on its first section, Agents for most, regardless of the previous visit; Settings › Workspace says the workspace it shows is a shared one.
