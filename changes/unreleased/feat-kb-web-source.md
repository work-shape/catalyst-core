---
section: Added
---

- **Knowledge:** Public web pages are a synced source of a Knowledge Base. A Connection of the
  new built-in type `web` names the hosts it may read and needs no secret; a source through it
  names `pages`, `prefixes` (everything below an address, `maxDepth` 3 by default) or `sitemaps`
  in place of `folders`, and `include`/`exclude` match the address's path. A link to another
  host is never followed. Each request passes the egress policy and must reach a public address
  (an entry with `network: private` is refused), a redirect is checked again, robots.txt is
  honored, one request a second goes to a host unless the Connection's
  `requestsPerSecond` says otherwise, and a page or linked PDF, DOCX or TXT larger than the
  limits is left out. Pages are read again conditionally (ETag, Last-Modified, else a hash of
  the text); by default the type polls hourly and passes in full each Monday at 03:00
  (`documentSource.schedule`), and no source or release setting polls it more often than hourly. The
  operator opens public hosts with the egress policy's public HTTPS setting.
  Only 404, 410, a robots.txt rule or a full pass that no longer reaches a page withdraws it;
  an unreadable robots.txt, a 401 or 403, or a host that does not answer keeps the document.
- **Knowledge:** A search passage of a synced document carries `statedAt`, the date the document
  states of its own version (for a web page its "Stand"), and `retrievedAt`, when the platform
  fetched it.
- **Chat:** A citation of a synced document shows the date it states ("Stand 01.11.2026", "as of
  01/11/2026"), else only the day it was retrieved ("abgerufen 10.11.2026", "retrieved
  10/11/2026").
- **Studio:** A source through a web Connection is edited with fields for pages, addresses to
  read everything below, and sitemaps.
