---
section: Fixed
---

- Apps allow form submit events and downloads while keeping an opaque origin and blocking form navigation. Saved Apps provide a `localStorage`-compatible runtime backed by private per-App, per-person state; unsaved previews use temporary state. Kit 1.6.0 adds `storage.get/set` for JSON values with awaited persistence. The App-building guidance names the form, storage and network rules and directs shared records to Data Stores.
- Publishing uses the localized workspace name consistently and shows the App's published state immediately. A chat view that fails or times out shows LoadError with retry.
