---
section: Changed
---

- The default theme's neutrals lose their brown cast: a clean off-white in light mode and a cool near-black in dark mode, so surfaces, borders and muted text read clearer. Light: surface `#fafaf8`, background `#f3f3f0`, text `#1c1c1b`, muted text `#5e5d5a`, border `#e1e0dc`. Dark: surface `#18181a`, background `#131315`, text `#ececeb`, muted text `#a9aaac`, border `#2d2d30`. The accent is unchanged. An instance that sets its own theme colours is not affected.
- The person's own message sits on a neutral fill instead of the accent tint.
- The info tone is now a soft blue (`#32669a` light, `#6fa8dc` dark) and serves as the quiet second accent beside the orange: it marks work that runs. The dock's running dot and the running count on Settings > Jobs use it; badges and banners in the info tone follow. `CountBadge` has a new `info` tone.
- The activity row of a running answer (spinner, time and what the agent does) is in the accent colour instead of muted grey, like the running mark of a conversation in the sidebar.
