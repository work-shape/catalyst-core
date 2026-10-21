---
section: Added
---

- **Apps:** Where release config sets `apps.draftHosts.enabled` (off by default), a builder can allow an outside host a draft lists for their own preview of the draft, before it is published, with **Allow for my preview** on the draft of an App or on a Page in a conversation (`apps.allow_draft_host`). Only that person's frame connects to it, and only after a click in their own signed-in browser. Hosts with a scheme, port, path or wildcard, IP addresses and names of private networks are refused. The allowance ends once the draft no longer lists the host, and with a publish or a discard. Each allowance is recorded as `app.draft_host_allowed` (an App) or `app.page_draft_host_allowed` (a Page), without the draft or what it read. The preview says when the draft reads data an allowed host could receive. See [Outside hosts in a draft](/configure/release-config/#outside-hosts-in-a-draft).
