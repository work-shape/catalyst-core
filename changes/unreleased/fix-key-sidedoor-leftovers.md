---
section: Fixed
---

- A test run started with a personal API key that reaches a step needing a right no key can carry, such as `mail_sender.use` of a `mail.send` step, fails with `tester_key_cannot_carry` and says to start the test run signed in to the app. Before, it failed with `tester_missing_right` and told the person they lacked a right they hold. A right a key can carry and this key does not name fails with `tester_key_scope`. No key gains `mail_sender.use`.
- `workflows.start` and `workflows.test` with an API key that may not read the Workflow answer another person's run key with the `NOT_FOUND` a missing Workflow gets, instead of that run's id, status and starter. A run the same key started is answered as before, and so is a person signed in to the app; a run its person started otherwise is answered to the key only with `workflow.read`.
- The key `catalyst setup` asks for no longer starts with `connection.use` ticked: it is a separate choice, off by default (connections-and-secrets.md, Exposure to outside clients). The rest of the use level stays ticked.
- A test covers a key's held call that another person approves after the key was revoked: the call is denied and does not run.
