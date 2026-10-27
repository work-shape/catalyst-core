---
section: Fixed
---

- The API no longer serves a stored file inline when a browser would run it. A conversation file, an agent's artifact or an operation's download goes out inline only as a PNG, JPEG, WebP or GIF image, a PDF or plain text, whatever a capability's `isInlineDisplayMimeType`, the file name or the caller asked for; HTML, SVG, XML and every other type go out as an attachment, and the conversation file routes now send `X-Content-Type-Options: nosniff`. Before, an HTML file named `*.pdf` or promoted by the agent as an image ran on the API origin.
