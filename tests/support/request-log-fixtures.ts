// Raw request targets for serializer tests; none of these fixtures calls an endpoint.
export const requestLogCases = [
  ["/health", "/health"],
  [
    "/items?limit=20&cursor=private-id&q=private-name",
    "/items?limit=20&cursor=[redacted]&q=[redacted]"
  ],
  [
    "/items?limit=private-id&Limit=20&offset=5",
    "/items?limit=[redacted]&Limit=[redacted]&offset=[redacted]"
  ],
  [
    "/items?token=one&token=two&empty=&flag",
    "/items?token=[redacted]&token=[redacted]&empty=[redacted]&flag=[redacted]"
  ],
  ["/items?%63ursor=private%26id&%6cimit=50", "/items?cursor=[redacted]&limit=50"],
  [
    "/items?bad=%E0%A4%A&limit=-1&limit=1e3",
    "/items?bad=[redacted]&limit=[redacted]&limit=[redacted]"
  ],
  ["/items?x=a=b?c&x=secret+words#private-fragment", "/items?x=[redacted]&x=[redacted]"],
  ["https://user:private-password@example.test/items?token=private", "/items?token=[redacted]"],
  ["/items#private-fragment", "/items"],
  ["/items?", "/items"],
  ["/app-content/private-token/index.html?limit=10", "/app-content/[redacted]?limit=10"],
  ["/app-content/file-set/private-token/private-file.pdf", "/app-content/[redacted]"],
  ["/app-content/file-set/private-token", "/app-content/[redacted]"],
  ["//APP%2dCONTENT//file-set/private-token/%", "/APP-CONTENT/[redacted]"],
  ["/%61pp-content%2Ffile-set%2Fprivate-token", "/app-content/[redacted]"],
  [
    "/api/auth/reset-password/private-token?callbackURL=private",
    "/api/auth/reset-password/[redacted]?callbackURL=[redacted]"
  ],
  ["/api/auth/reset%2dpassword%2fprivate-token", "/api/auth/reset-password/[redacted]"],
  ["/app-content-other/asset.js?version=private", "/app-content-other/asset.js?version=[redacted]"]
];
