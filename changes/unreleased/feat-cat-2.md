---
section: Added
---

- Release config Connections can name an offered catalogue part with `fromEntry` and `part`. Startup expands its settings and operations, keeps its entry, part and version, and refuses unknown or unavailable parts. OAuth parts are refused in release config with a setup message.
- `catalyst catalogue list` lists the instance's entries. `catalyst connection init <name> --from <entry> [--part tools|source]` writes a local `connections/<name>/connection.yaml` with defaults and catalogue provenance, with operations disabled and unexposed, without overwriting an existing file.
