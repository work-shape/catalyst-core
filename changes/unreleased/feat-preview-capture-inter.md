---
section: Added
---

- **Preview capture:** the renderer image (the deployment kit's `preview-capture` target and the
  package's own Dockerfile) installs Debian's `fonts-inter` (Inter, OFL-1.1), so HTML printed by
  `workspace.html_to_pdf` or `pdf.download` with `font-family: Inter` renders in Inter without
  any network request. The image grows by about 10 MB.
