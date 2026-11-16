---
section: Added
---

- **Bedrock prompt cache:** an agent run's calls on `aws-bedrock` set four prompt cache
  breakpoints (the last tool, the agent's instructions, the end of the previous request and the
  call's own end), so each turn reads the tools, the instructions and the conversation so far
  at the cache read rate. Calls the product makes for itself set none. The usage record keeps
  the input written to the cache apart from the input read from it, and a rate card row prices
  cache writes with the new optional `cacheWriteInputPricePerMillionTokens`; a row without it
  prices them as uncached input. `catalyst models add bedrock` takes `--cache-write-price`.
