---
section: Fixed
---

- **Inbox:** An approved call whose outcome was written while another transaction held its
  request, such as a second click on "Freigeben" or "Erlauben" that was being refused, no longer
  stays "queued" for good. The write is tried again for about three seconds; a request still
  held after that gets its outcome from the run at the next upkeep pass, and the server logs a
  warning. Before, the call ran but its Inbox item never said so.
