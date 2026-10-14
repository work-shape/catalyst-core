import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Browser tabs start with "Docs", so the site stands apart from a running Catalyst instance
// beside it: "Docs · Workshape Catalyst" on the home page, "Docs · <page title>" elsewhere.
export const onRequest = defineRouteMiddleware(({ locals }) => {
  const { entry, head, id, siteTitle } = locals.starlightRoute;
  const title = head.find((tag) => tag.tag === "title");
  if (title) title.content = `Docs · ${id === "" ? siteTitle : entry.data.title}`;
});
