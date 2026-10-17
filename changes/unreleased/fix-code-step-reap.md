---
section: Fixed
---

- **Sandbox:** A command of the `local` sandbox no longer leaves running what it started in the background. When the command ends, by itself, at its time limit or at a cancel, every process still in its process group is killed, and the result no longer waits for a process that left the group and holds the command's output open: it waits one second at most. A process that left the group with a session of its own or a double fork is still out of reach of the `local` sandbox, which is for development only. In the `docker` sandbox the script of a code step is the first process of its container, and every process of the container ends with it, including one in a session of its own; the tests now check this against the runner image.
