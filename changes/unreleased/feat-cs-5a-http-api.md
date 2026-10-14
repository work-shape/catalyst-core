---
section: Added
---

- **REST connections on the server (CS-5a 1/2):** the connector type `http_api` reads a REST interface by declared GET operations (CS-5a 1/2). Settings `baseUrl`, fixed non-secret `headers`, an optional `testPath` and `headerName`; a header that can carry a credential is refused as `credential_in_settings`. Auth `none`, `bearer` or `header`. Each operation declares `method: GET`, `effect: reading`, a `path` template with `pathParams` and `query`, and a `description`; caller input fills only the declared parameters, a path parameter holding `/` or `..` is refused as `input_invalid`, and no redirect is followed. The answer is JSON under 2 MiB and a list comes back as `{ items }`. Without `testPath` a test answered 401 or 403 is "key refused" and any other answer reachable. Changing the host of `baseUrl` clears the stored key. The key `scope` on an operation is reserved for SCOPE-2 and refused at save.
