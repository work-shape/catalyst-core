---
section: Fixed
---

- **Workflows:** Workflow asset reads now include per-step facts resolved under the reader's rights, including source names and service icons, operation schemas and availability, child Workflow titles, the AI model and the next scheduled time. Operation nodes use these facts for their chips and effects. Step runs expose bounded resolved input previews alongside output previews; pruning removes both. Definition problems retain their step paths. No migration or new right is required.
