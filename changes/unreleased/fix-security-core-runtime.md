---
section: Fixed
---

- Upgrade SheetJS readers to the upstream 0.20.3 tarball, raise the published CLI and asset-schema js-yaml minimum to 4.3.2, and patch multipart parsing, Seroval, Fastify routing/URI parsing and Better Auth dependencies.
- Use the legacy spreadsheet reader for ODS files that the primary XLSX reader accepts without finding any worksheets.
- Keep app-content tokens out of request logs through Fastify’s supported log controller, and return a 400 product error for malformed multipart uploads.
- Pin and verify the SheetJS tarball integrity in the release gate so lock regeneration cannot silently remove its checksum.
