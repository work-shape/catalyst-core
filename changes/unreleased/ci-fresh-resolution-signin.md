---
section: Changed
---

- The release's fresh consumer gate now seeds its sign-in user through the deployments' `seed-auth` entry before starting the server, generates its database password in the job, names the failing step on the run's summary page and prints the server's log when a start or request fails.
