---
section: Changed
---

- The default theme's neutrals lose their brown cast: a clean off-white in light mode and a cool near-black in dark mode, so surfaces, borders and muted text read clearer. Light: surface `#fdfdfc`, background `#f6f6f4`, text `#1c1c1b`, muted text `#5e5e5b`, border `#e4e4e1`. Dark: surface `#1b1c1f`, background `#151619`, text `#ececeb`, muted text `#a9abaf`, border `#2f3135`. The accent is unchanged. An instance that sets its own theme colours is not affected.
- The person's own message sits on a neutral fill instead of the accent tint.
- The info tone is now a soft blue (`#32669a` light, `#6fa8dc` dark) and serves as the quiet second accent beside the orange: it marks work that runs. The activity row of a running answer (spinner, time and what the agent does), the running mark of a conversation in the sidebar, the dock's running dot and the running count on Settings > Jobs use it; badges and banners in the info tone follow. `CountBadge` has a new `info` tone.
