---
section: Added
---

- **Usage:** The context indicator's hover card in the composer can show what a conversation has
  cost so far: "Kosten bisher 1,84 €" / "Cost so far €1.84", in the Customer Rate Card's currency
  and the person's locale. It sums the settled cost of the chat's calls, its subagent threads
  and its title; a call still running is not in it, and an incomplete cost reads "at least". In
  a private chat a person sees their own calls; in a team chat or a chat shared with named
  people their own share ("Deine Kosten bisher"), and a holder of `usage.view` the whole chat's.
  The new read `conversations.cost.get` (`GET /api/v1/conversations/:conversationId/cost`)
  answers it. Off by default: `usage.showConversationCost: true` in release config turns it on;
  off, the read answers not found (LU-7).
