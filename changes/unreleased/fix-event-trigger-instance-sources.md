---
section: Fixed
---

- **Workflows:** a Workflow of a workspace whose `platform_event` trigger names a Knowledge Base of the instance now starts on that Knowledge Base's events. The publish accepted such a trigger and checked the account's right on the Knowledge Base, but the dispatcher heard only sources of the Workflow's own workspace and skipped the event without a trace. A workspace's Workflow now hears the events of its own workspace's sources and of the instance's, the sources it may name; another workspace's events still start nothing, and the account still needs the event's right on the source.
