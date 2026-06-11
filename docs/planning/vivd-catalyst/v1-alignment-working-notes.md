# V1 Alignment Working Notes

Last updated: 2026-06-10

This note tracks the implementation issues closed during the v1 alignment pass and the remaining follow-up candidates. It is intentionally a working note, not an ADR.

## Closed Alignment Issues

- Standalone login now uses real email/password sessions through Better Auth, with seeded demo superadmin and normal user accounts. The visible development-user switch is no longer part of the primary standalone UI.
- Chat streaming now uses Vercel AI SDK stream semantics behind the product-owned agent runtime and chat API seams.
- The chat surface now uses assistant-ui primitives/runtime while conversation ownership, audit, auth, and persistence remain in the platform backend.
- The UI now has shadcn-style local primitives for common controls without coupling package consumers to a hosted design system.
- The app shell is fixed-height. The sidebar, chat thread, and superadmin panel own their own overflow instead of scrolling the whole document.
- TanStack Router is implemented in the standalone shell. TanStack Query remains the documented server-state default outside the live chat stream.
- Local dev now has a production-shaped standalone path backed by Postgres auth/session/conversation state.
- Postgres-backed persistence now uses Drizzle inside storage/auth adapters. Drizzle types stay private; platform callers still use product-owned store/auth interfaces.
- The dev-user listing route has been removed. Local standalone testing uses seeded Better Auth users instead of a browser-visible dev-user switch/listing API.
- The architecture review skill was rerun after implementation. The report is an external HTML artifact in the OS temp directory.

## Remaining Follow-Up Candidates

- Deepen the API Contract module from a schema barrel into an operation catalog that drives server routes, API client methods, and future OpenAPI generation.
- Split the Control Plane out of Chat UI once governance grows beyond the current superadmin usage/audit panel.
- Split the assistant-ui runtime adapter from thread presentation once the chat package needs more assistant-ui customization or visual variants.
- Split Postgres migrations by product area once another storage domain, such as retrieval, files, or retention jobs, lands.
