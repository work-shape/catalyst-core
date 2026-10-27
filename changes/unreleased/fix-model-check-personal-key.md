---
section: Fixed
---

- **Models:** Model checks and `catalyst models list --instance` accept a personal API key with the `system.view` scope when its owner holds that right. This scope reaches only the read-only infrastructure check; service keys remain refused. Issue a new personal key to add the scope to an existing CLI login. The CLI explains a missing right or key scope, announces rate-limit waits, and prints the model provider's id. The model setup docs explain the inherited `openai` provider in demo-based configs.
