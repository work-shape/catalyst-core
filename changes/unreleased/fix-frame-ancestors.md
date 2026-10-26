---
section: Fixed
---

- Another site can no longer frame the interface. The interface image's nginx sends `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` with the interface, and the API sends `X-Frame-Options` with its HTML documents; the view shell now also says `frame-ancestors`, with the instance and the interface origins (`allowedOrigins`), like Page content. Behind a proxy that serves the interface on another origin than the API, that origin must be in `allowedOrigins`, as it already must for the API.
