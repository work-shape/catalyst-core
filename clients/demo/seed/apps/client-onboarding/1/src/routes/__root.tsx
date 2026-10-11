import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <nav className="flex gap-4" aria-label="Sections">
        <Link to="/">Steps</Link>
        <Link to="/documents">Documents</Link>
      </nav>
      <Outlet />
    </main>
  )
});
