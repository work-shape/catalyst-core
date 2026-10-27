---
section: Added
---

- The agent learns what the preview it opened did. Before its next model request, a run that opened a revision adds a short note to the `workspace.open` result: whether the page loaded, whether the kit's bridge connected, whether the page drew anything, and up to a few hundred characters of its errors and failed calls. It reads only the report of the person whose turn the run serves, never another member's. It waits at most 6 seconds, and only while that person has a preview of the conversation open; otherwise the note says "not viewed" at once. A report that arrives later is noted once before a later model request. No extra model call or tool is spent. The interface now sends the settled report right after the mount instead of 5 seconds later.
