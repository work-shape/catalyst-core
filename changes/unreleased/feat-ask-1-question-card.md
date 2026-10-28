---
section: Added
---

- **Chat:** An agent can ask the person one question with two to four answers (ASK-1). The conversation shows it as a card, the recommended answer first; the agent's turn ends there. Picking an answer, or writing one on the card or in the composer, sends it as the person's message and the agent goes on. An answered card shows the answer and takes no other, also after a reload.
- **Agent tools:** `ask_question` is offered to every agent of a conversation, not to subagents or Workflow steps. Its description tells the agent to ask only about outcomes the person cares about, in everyday words, and to decide technical choices itself.
- **Agent tools:** `platform.files.list` answers `href` for the conversation that holds each file, so the agent links that conversation instead of naming it.
- **UI library:** `Choice` and `ChoiceList`, answers to a question as full-width buttons.
- **Workshaper:** Before building, it breaks the request into small steps, says what works on the instance and what needs an administrator or Workshape, asks open choices with the question card, and builds and tests the smallest working piece first. It links the conversation that holds an App's files and names no interface path it has not seen in the docs or tools. The Workflow authoring skill asks for a plain description of every step and for data loaded once, with independent items in a loop with `concurrency`.
