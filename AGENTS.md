# BlockPlan Agent Instructions

## Project Overview

- BlockPlan is a static browser-based architectural block planning tool.
- `docs/index.html` must continue to work when opened directly in a browser.
- Do not introduce a bundler, framework, or build step for the app runtime.
- `package.json` and Playwright are allowed only for development/test verification.

## Source of Truth

- `plan.cells` is the source of truth for planning geometry.
- Categories and module size are part of the saved plan state.
- Dashboard values, zones, canvas rendering, PNG exports, screenshots, and Playwright artifacts are derived outputs.
- Do not treat screenshots or PNG files as editable source data.

## Hidden Browser API

- `window.BlockPlanAPI` is a hidden debug/test bridge for Codex and Playwright.
- The API must not add visible UI or change normal user workflows.
- API operations must update the same plan state used by the UI.
- After API mutations, keep canvas, dashboard, localStorage, and save status in sync.
- API methods must not trigger `confirm()`, `prompt()`, file input clicks, or downloads.

## API Response Contract

- New or changed API methods should use a stable response contract.
- Mutation methods should return `{ ok: true, ... }` on success and `{ ok: false, error: "..." }` on failure.
- Read methods may return direct data only if the Playwright tests clearly document that contract.
- Do not mix response styles inside the same method family without updating tests.
- Any API contract change must update `tests/blockplan-api.spec.js`.

## Playwright Verification

- Playwright is for GUI smoke testing, API verification, screenshots, and artifact inspection.
- Playwright screenshots are review artifacts, not source of truth.
- Design/planning quality judgment should use API data, dashboard metrics, screenshots, and human/Codex review together.
- Tests should use stable `data-testid` selectors.

## Generated Artifacts

- Do not commit generated screenshots, PNG files, ZIP files, `test-results/`, browser artifacts, or `node_modules/`.
- Keep generated visual artifacts local, in CI artifacts, or in Codex task artifacts.

## Verification

For normal changes, run when applicable:

```bash
node --check docs/app.js
node --check docs/interaction-patch.js
node --check docs/blockplan-api.js
node --check tests/blockplan-api.spec.js
git diff --check
```

If Playwright dependencies are available:

```bash
npm test
```

If Playwright cannot run because dependencies cannot be installed, report the reason clearly.
