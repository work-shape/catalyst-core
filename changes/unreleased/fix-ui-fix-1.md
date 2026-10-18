---
section: Fixed
---

- `mountChatWidget` passes every prop of the chat shell to it, not only the address, the token and the class name.
- The Apps area offers New, Build with the agent and Save as app by the App rights the reader holds in the open workspace, never by rights in another workspace. Edit, Publish and Delete of one App follow what the instance says the reader may do to that App in list and detail answers, so a grant or deny on that App alone controls Edit, Edit with the agent and Delete. Asset-only draft writers can reach the editor from the list, and a failed App record read offers Try again.
- Asset list and detail answers include the caller’s `read` right in `allowed`. Update the server and UI together: an older server’s `allowed` omits `read`, so the new UI hides Details on that answer.
- The Knowledge Base chooser of an agent and the Data Store chooser of a Knowledge Base list those of the asset's own workspace beside the instance's, as the skill chooser does. The instance still checks each reference when it is saved.
- Publishing an agent's draft from its page refreshes the lists of offered agents and the configuration. A publish that waits for an approval refreshes nothing.
- The page of a Workflow run says when the steps of the run could not be loaded, also when a later reading fails after steps were shown, and Try again reads the run and its steps again. A failed run refresh keeps the existing notice that the instance has not answered, even when the steps also fail.
