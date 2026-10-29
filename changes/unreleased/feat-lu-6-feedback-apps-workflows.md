---
section: Added
---

- **App Kit 1.9.0:** `<AppFeedback />` and `catalyst.feedback.send(text)`. A published App with the module `feedback` on offers a written comment to the people who use it; the host names the App and its revision, so the App sends only the text. A draft, a Page and an App with the module off show no form. New Apps name kit 1.9.0; Apps on older kits are unchanged.
- **Feedback on a Workflow's result:** a notice that leads to a Workflow run offers its reader "Feedback on this result", once per run. Nothing of the run or the notice is copied into the comment; it names the run by its id.
- Reviewers holding `feedback.review` for the instance or the owning workspace get comments on Apps and Workflow results as Inbox items of kind `feedback_review`, which name the App or the Workflow and lead to the App or the run. The operations `feedback.send_from_app`, `feedback.send_on_result` and `feedback.list_own_on_result` reach the same through the API. These comments cannot yet be changed or withdrawn.
