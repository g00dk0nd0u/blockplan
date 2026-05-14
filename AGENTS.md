# AGENTS.md

## Project Purpose

BlockPlan is a plain HTML, CSS, and JavaScript pre-BIM zoning sketch tool. It should stay lightweight, fast to open, and easy to publish on GitHub Pages.

## Constraints

- Do not add React, Vite, npm, bundlers, transpilers, or build steps.
- The app must run by opening `docs/index.html` locally.
- Keep the code readable and modular.
- Prefer simple browser APIs over dependencies.
- Use HTML Canvas for the planning surface.

## Data Model

Keep plan data centered on:

- `moduleSizeMm`
- `categories`
- `cells` keyed by `"x,y"`
- each cell storing `categoryId`
- dashboard values calculated from cells

Prepare for future boundary, subdivision, isolation, and export features without implementing them prematurely.

## UX Direction

- This is not a CAD replacement.
- Prioritize speed, clear feedback, and low-friction sketching.
- Keep the visible UI focused on zoning, module size, save/load, export, and dashboard metrics.
- Avoid heavy animations and decorative complexity.
