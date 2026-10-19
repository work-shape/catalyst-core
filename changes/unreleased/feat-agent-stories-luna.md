---
section: Changed
---

- `pnpm test:agent-stories` runs the owned stack's agents on gpt-5.6-luna at reasoning effort `xhigh` by default instead of gpt-5.5 at `high`. `--model <bindingId>` and `--reasoning <effort>` choose another demo binding and effort for a rerun. The Runs line shows the chosen model and effort and the models agent runs actually called.
