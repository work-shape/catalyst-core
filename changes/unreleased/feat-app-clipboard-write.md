---
section: Added
---

- **Apps can copy to the clipboard:** A Copy button in an App, published or in draft, now works. The App's frame has the permissions policy `clipboard-write`, so `navigator.clipboard.writeText` succeeds on a user click. Reading the clipboard is still blocked, and the frame is sandboxed as before, without `allow-same-origin`.
