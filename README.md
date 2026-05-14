# BlockPlan

BlockPlan is a super-quick web-based architectural zoning and planning tool for early pre-BIM studies. It is not a CAD replacement. It is meant for designers who want to sketch zoning layouts quickly before opening Revit.

## Run

Open `index.html` directly in a browser.

No install, npm, build step, or local server is required. The app is also ready to publish with GitHub Pages.

## Create a Review Package

To create a ZIP file of the repository for ChatGPT review:

```bash
python3 user_tools/export_review_package.py
```

The ZIP is written to `output/review_packages/`.

## Features

- HTML Canvas grid planner
- Module selector from 300 mm to 9600 mm
- Category-based cell painting by click or drag
- Connected same-category cells calculated as zones
- Real-time dashboard for area, zone count, and cell count
- Mouse wheel zoom
- Middle mouse or Space + drag pan
- JSON save and load
- Local auto-save with `localStorage`
- PNG export

## Data Model

Plans are stored as simple JSON:

```json
{
  "version": 1,
  "moduleSizeMm": 3600,
  "categories": [],
  "cells": {
    "0,0": {
      "categoryId": "office"
    }
  }
}
```

The cell map is intentionally simple so future features can add external boundaries, subdivision, isolation, and Revit-oriented exports without replacing the core model.

## Files

- `index.html` - app structure
- `style.css` - layout and visual design
- `app.js` - canvas drawing, painting, zones, save/load, export
- `user_tools/export_review_package.py` - creates a review ZIP for ChatGPT
- `AGENTS.md` - guidance for future coding agents

## Current Scope

Implemented now:

- Fast grid-based zoning
- Connected-zone calculation
- Dashboard metrics
- JSON and PNG output

Not implemented yet:

- Rounded external boundaries
- Revit export
- Subdivide or isolate tools
- CAD-like precision editing
