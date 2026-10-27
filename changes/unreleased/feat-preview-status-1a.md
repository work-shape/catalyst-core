---
section: Added
---

- A Page or App draft preview reports on itself to its conversation. The report says whether the frame loaded, whether the kit greeted within 5 seconds, and whether the page drew anything. It lists uncaught errors, unhandled rejections, `console.error` calls, content policy violations, and failed calls by action name and refusal code. Each report holds at most 10 distinct entries with counts, 200 characters per message and 2 KB in all. Quoted text over 24 characters, digit runs, address queries, mail addresses and IBANs are scrubbed in the browser and again on the server. No audit event, log line or Operation Run holds a report. Only the latest report per conversation and file set is kept, for 24 hours.
