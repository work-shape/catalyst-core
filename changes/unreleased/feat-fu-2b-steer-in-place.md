---
section: Added
---

- **Chat:** A message steered into a run is shown where the run took it in, between the step it followed and the answer it led to, in every open tab, once the run completed and after a reload (FU-2). The run projection gains the part `user_message` (`messageId`, `text`, `createdAt`) at that place; a client that renders projection parts should skip or show it.
