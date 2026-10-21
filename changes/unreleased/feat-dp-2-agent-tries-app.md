---
section: Added
---

- An agent tries an App's draft as the person's click does, before anything is published: `apps.try_action` calls one action of the draft of the conversation's subject App, or of an App the conversation created, with the same draft context and answer as the button. A `workflow` action starts a test run of the Workflow's draft (or its published revision for a person who may only use it) and the answer names the run and the revision that runs; the call is the button's own run, with the conversation in its origin. It asks the person's right to write the App.
- `apps.publish_review` reads what publishing an App's draft comes to: the App and the Workflows its actions call, what is pending in each, the sentence each publish question leads with, and each missing right or check that would refuse a publish now. It changes nothing. `publishesTogether` is `false` until one Publish of the App also publishes its Workflow drafts.
- Both are agent tools offered with the App tools. Workshaper, the `workflow-authoring` skill and the docs pages "App or Workflow" and "Workflow actions" say to try through `apps.try_action` and never to ask the person to publish in order to try something.
