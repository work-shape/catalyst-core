---
section: Added
---

- A capability's asset kind can read its own files into its manifest and config, and its kind's publish can carry a guardrail: `form_page.before_publish` is the first, for the form pages of outside forms.
- Capabilities reach the published revisions and files of the asset kinds they bring, and the scope of the Workflow an Operation Run serves.
- The shipped guardrail "Publishing needs an instance admin's approval" holds a form page's publish as a `form_page_publish` request, which a holder of `app.approve` decides.
