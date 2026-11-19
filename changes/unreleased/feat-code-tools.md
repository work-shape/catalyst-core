---
section: Added
---

- **Code tools (TOOL-2b):** a tool asset of type `code` holds a handler in Python or JavaScript
  among its files (`runtime`, `entry`, `timeoutSeconds` up to 120 seconds, at most 32 files and
  512 KiB). A call of `tool.<name>.call` runs the handler on the workspace command worker in the
  sandbox of Workflow code steps: no network, a read-only root, an empty environment and the
  limits of a code step. The handler reads the input as a code step does and answers
  `{ "output", "display"? }`; a `data` display becomes the conversation's structured result and an
  `html` display is shown as `show_view` shows it. A handler past its time is stopped and the call
  fails with `timed_out`; the time counts from the start of its container, and a call that
  finds no free container within 30 seconds, or before the agent's tool deadline, fails with the
  reason `queued`. The end of a failed handler's error stream reaches the model alone; the
  Operation Run keeps the reason. Each command worker runs at most two handlers at once, and its
  startup memory check counts them as `code tools` with the memory of a code step. Code tools
  cannot call Connections yet.
