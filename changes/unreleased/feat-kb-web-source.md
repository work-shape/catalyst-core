---
section: Added
---

- **Knowledge:** Public web pages are a synced source of a Knowledge Base. A Connection of the
  new built-in type `web` names the hosts it may read and needs no secret; a source through it
  names `pages`, `prefixes` (everything below an address, `maxDepth` 3 by default) or `sitemaps`
  in place of `folders`, and `include`/`exclude` match the address's path. A link to another
  host is never followed. Each request passes the egress policy, a redirect is checked again,
  robots.txt is honored, one request a second goes to a host unless the Connection's
  `requestsPerSecond` says otherwise, and a page or linked PDF, DOCX or TXT larger than the
  limits is left out. Pages are read again conditionally (ETag, Last-Modified, else a hash of
  the text); a full pass runs weekly by default and the feed polls at most hourly. The
  operator opens public hosts with the egress policy's public HTTPS setting.
- **Knowledge:** A search passage carries `modifiedAt`, the date of its document: for a web page
  the date the page states, else its Last-Modified or the day it was first read.
- **Chat:** A citation of a synced document shows its date ("as of 01/11/2026", "Stand
  01.11.2026").
- **Studio:** A source through a web Connection is edited with fields for pages, addresses to
  read everything below, and sitemaps.
