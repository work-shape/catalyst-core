---
section: Changed
---

- The default theme's neutrals lose their brown cast: a clean off-white in light mode and a cool near-black in dark mode, so surfaces, borders and muted text read clearer. Light: surface `#fcfcfa`, background `#f4f4f1`, text `#1c1c1b`, muted text `#5e5d5a`, border `#e3e2de`. Dark: surface `#19191c`, background `#141417`, text `#ececeb`, muted text `#a9aaac`, border `#2e2f32`. The accent is unchanged. An instance that sets its own theme colours is not affected.
- The person's own message sits on a neutral fill instead of the accent tint.
- The info tone is now a soft blue (`#32669a` light, `#6fa8dc` dark) and serves as the quiet second accent beside the orange: it marks work that runs. The activity row of a running answer (spinner, time and what the agent does), the running mark of a conversation in the sidebar, the dock's running dot and the running count on Settings > Jobs use it; badges and banners in the info tone follow. `CountBadge` has a new `info` tone.
