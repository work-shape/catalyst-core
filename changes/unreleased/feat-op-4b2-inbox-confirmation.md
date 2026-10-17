---
section: Added
---

- **The confirmation in the Inbox (OP-4b2):** A confirmation addressed to one person, from an Agent Run nobody watched or from `catalyst app publish --yes` and `catalyst workflow publish --yes`, now shows as its own item. It is headed "Confirm an action" or "Confirm publishing “…”", says who asks on the person's behalf (the agent, or their command line), shows the frozen call or the publish review, and says "The run waits until you decide" or "Nothing is published until you decide", and that nobody else can decide it. It offers **Allow** and **Deny** ("Erlauben", "Verweigern") with an optional comment, and no request for changes and no Always allow. Its state reads "Waits for you", "Allowed", "Denied", "Expired" or "Withdrawn", and the item says what became of the call. A person who is not the addressee gets the not-found state the server answers, as before.
- The conversation of a run whose confirmation waits in the Inbox shows that it waits there, with "Open in Inbox", instead of Allow and Deny.
