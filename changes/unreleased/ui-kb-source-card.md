---
section: Changed
---

- **Knowledge Bases:** a Knowledge Base whose documents all come from a synced folder leads with
  **Sync now** in place of **Add documents**; uploading files and connecting another folder wait in
  the head's menu, since an uploaded file would lie beside the synced ones and never sync. One with
  both kinds keeps **Add documents** with **Sync now** beside it.
- **Knowledge Bases:** behind **Adjust**, a synced source sets how it keeps itself up to date in
  one column of rows, each control beside its label: the switch, how often changes are fetched, and
  when deleted files are removed, as one button that reads like "Daily at 02:00". The published
  schedule is named a second time only where a change waits for its publish.
- **Interface library:** `SettingsList` and `SettingsRow` put a setting's label, one line about it
  and its control in one row; `ScheduleField` takes `labelHidden`.
