---
title: Framework Choice
description: Why the docs package uses Astro Starlight.
---

The docs package uses Astro Starlight.

## Why Starlight

Starlight fits this repository because it is:

- documentation-first
- Markdown-first
- static by default
- built on Astro and compatible with the Vite ecosystem
- easy to run as a private package in the pnpm workspace
- already equipped with sidebar navigation, site search, dark mode, code highlighting, SEO basics, and i18n-oriented features

Those defaults are enough for operator docs. The docs package should not become a custom app unless the documentation needs real product behavior.

## Alternatives Considered

Docusaurus is a strong React documentation framework with versioning support, but it would add a larger React site stack for a docs surface that currently needs mostly Markdown.

VitePress is simple and fast, but it brings Vue into a repository whose product frontend stack is React and whose docs need no Vue-specific customization.

Starlight keeps the dependency small and content-focused while leaving room for Astro integrations later.

## Package Boundary

The docs live in `packages/docs` as `@vivd-catalyst/docs`.

This keeps operator docs close to the platform packages while leaving the workspace-level `docs/planning` folder as the internal architecture and decision map.
