---
section: Fixed
---

- From 768 px up, a conversation with no surface beside it scrolls to the very top of the window again. The chat header is no longer a solid band there: the agent picker floats over the thread on a light fade, as it did before the phone-width fixes. At phone width, beside a surface and outside a conversation the header keeps its band. At rest the first message still starts below the picker.
- A tool call with a long input, such as a long command, keeps its row inside the thread. Its title ("Run command") stays on one line, and the preview of the input takes the rest of the row and ends in an ellipsis instead of running past the thread to the window's edge. Opened, the call still shows the whole command.
- An App or a Page opened from the chat dock beside another page, such as a Workflow or the Agents, loads again. Its surface stood outside the interface's page host, so nothing answered the kit's `ready` and after 10 seconds the App said "The interface did not answer." It is now told who looks at it, as it is beside a conversation.
