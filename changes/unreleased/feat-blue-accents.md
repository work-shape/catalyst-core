---
section: Changed
---

- The default theme's neutrals carry about half their former warmth, so surfaces, borders and muted text read clearer and less muddy in both modes; they still lean slightly warm, never blue. Light: surface `#fcfbf9`, background `#f5f3f0`, text `#1e1c1a`, muted text `#625f5a`, border `#e4e1db`. Dark: surface `#171615`, background `#131211`, text `#edebe8`, muted text `#b0ada8`, border `#32302e`. The accent is unchanged. An instance that sets its own theme colours is not affected.
- The info tone is now a soft blue (`#32669a` light, `#6fa8dc` dark) and serves as the quiet second accent beside the orange: it marks work that runs. The spinner and elapsed time of a running answer, the running mark of a conversation in the sidebar, the dock's running dot and the running count on Settings > Jobs use it; badges and banners in the info tone follow. `CountBadge` has a new `info` tone.
