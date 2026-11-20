---
section: Added
---

- A starter an agent's author writes takes an icon. On the Agent page, each starter has a small button that opens the 24 starter icons and "Default"; `initialPrompts[].icon` holds the name, and a write with a name outside the list is refused. A starter without one keeps the icon it had.
- The empty chat shows up to 12 starters for an agent, where it showed 4. Up to four stand as before. More than four stand as short cards without the line under the title, in two columns and in three where the chat is wide; after the first six, "More" shows the rest. An agent whose own prompts and skills offer more than four starters now shows them.
- Workshaper's two starters carry icons. No database schema changes: an agent's config is stored as JSON.
