---
section: Fixed
---

- **Models:** a Claude binding on AWS Bedrock now offers and sends the reasoning efforts `xhigh`
  and `max`, so the chat's effort picker shows all five levels for Claude Opus, Sonnet and Haiku
  5.5. A call at `xhigh` or `max` allows 64,000 output tokens, so long thinking no longer cuts
  the answer off; the other efforts keep 16,000. A binding of an older model that refuses them,
  such as Claude Sonnet 4.6, lists its efforts in `userSelectableReasoningEfforts`.
