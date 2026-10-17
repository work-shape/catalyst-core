# HTTP API query parameters

An `http_api` operation declares each query parameter's JSON schema. Scalar values
are strings, integers, numbers or booleans. For repeated query keys, declare an
array with scalar `items`:

```yaml
name: list_postings
description: Reads postings matching every filter, in pages.
method: GET
path: /api/accounting/postings
effect: reading
exposure: [workflow]
query:
  filter:
    schema:
      type: array
      items: { type: string }
  page:
    schema: { type: integer }
  page_size:
    schema: { type: integer }
```

Input `{"filter":["client_id eq 1234","fiscal_year gte 20260101"],"page":1,"page_size":100}`
sends `filter=client_id+eq+1234&filter=fiscal_year+gte+20260101&page=1&page_size=100`.
Values are encoded individually, so `&`, `=` and `#` remain part of their value.
Order, duplicates and empty strings are preserved. An empty array sends no key.
Omitted and null query parameters keep their existing omission behavior.

Each array accepts at most 32 values (`HTTP_API_QUERY_MAX_VALUES`); the operation's
input schema exposes that cap and preserves a smaller declared `maxItems`.
Objects, nested arrays, null items and arrays above the cap fail with
`input_invalid` before any request. Array item schemas must name one scalar type;
objects, nested arrays and missing item types are refused at save and by the
agent's draft tool. Path parameters remain scalar.
