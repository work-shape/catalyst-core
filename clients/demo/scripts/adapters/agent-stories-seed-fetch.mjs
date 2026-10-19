// Retain only bounded request paths/statuses. Never headers, bodies or server text.
const REQUEST_DIAGNOSTICS_MAX = 8;
export function recordedSeedFetch(requests) {
  return async (url, init) => {
    const response = await fetch(url, init);
    const path = new URL(typeof url === "string" || url instanceof URL ? url : url.url).pathname;
    requests.push({ path, status: response.status });
    if (requests.length > REQUEST_DIAGNOSTICS_MAX) requests.shift();
    return response;
  };
}
