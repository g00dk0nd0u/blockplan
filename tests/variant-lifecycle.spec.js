const { test, expect } = require("@playwright/test");

const appUrl = `file://${require("path").resolve(__dirname, "../docs/index.html")}`;

async function prepare(page) {
  await page.goto(appUrl);
  await page.evaluate(() => window.BlockPlanAPI.setBubbleDiagram({
    version: 1,
    bubbles: [{ id: "room", name: "Room", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } }],
    connectors: []
  }));
}

test("deleteVariantSet removes only its Variants and unused Snapshot without changing geometry", async ({ page }) => {
  await prepare(page);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const make = (x) => ({ moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#abcdef" }], cells: { [`${x},0`]: { categoryId: "space", zoneId: `z${x}` } }, zoneAssignments: { [`z${x}`]: { bubbleId: "room" } } });
    const a = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "a1", requirementsSnapshotId: a.requirementsSnapshotId, blockPlan: make(1) });
    api.createVariant({ variantId: "a2", requirementsSnapshotId: a.requirementsSnapshotId, blockPlan: make(2) });
    const b = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "b1", requirementsSnapshotId: b.requirementsSnapshotId, blockPlan: make(3) });
    api.activateVariant("a1");
    const geometry = api.getPlan().cells;
    const deleted = api.deleteVariantSet(a.requirementsSnapshotId);
    return { deleted, geometry, plan: api.getPlan() };
  });
  expect(result.deleted).toMatchObject({ ok: true, deletedVariantIds: ["a1", "a2"], deletedVariantCount: 2, snapshotDeleted: true });
  expect(result.plan.generation.variants.map((item) => item.variantId)).toEqual(["b1"]);
  expect(result.plan.generation.requirementsSnapshots.map((item) => item.requirementsSnapshotId)).toEqual(["requirements-2"]);
  expect(result.plan.cells).toEqual(result.geometry);
});

for (const protection of ["child", "review", "preferred review"]) {
  test(`deleteVariantSet is atomic when protected by ${protection}`, async ({ page }) => {
    await prepare(page);
    const result = await page.evaluate((kind) => {
      const api = window.BlockPlanAPI;
      const make = (x) => ({ moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#abcdef" }], cells: { [`${x},0`]: { categoryId: "space", zoneId: `z${x}` } }, zoneAssignments: { [`z${x}`]: { bubbleId: "room" } } });
      const target = api.createRequirementsSnapshot().requirementsSnapshot;
      api.createVariant({ variantId: "one", requirementsSnapshotId: target.requirementsSnapshotId, blockPlan: make(1) });
      api.createVariant({ variantId: "two", requirementsSnapshotId: target.requirementsSnapshotId, blockPlan: make(2) });
      if (kind === "child") {
        const other = api.createRequirementsSnapshot().requirementsSnapshot;
        api.createVariant({ variantId: "child", parentVariantId: "one", requirementsSnapshotId: other.requirementsSnapshotId, blockPlan: make(3) });
      } else if (kind === "review") {
        api.createReview({ variantId: "one", decision: "accept" });
      } else {
        api.createReview({ variantId: "two", preferredOverVariantId: "one", decision: "iterate" });
      }
      const deleted = api.deleteVariantSet(target.requirementsSnapshotId);
      return { deleted, variants: api.listVariants(), snapshots: api.listRequirementsSnapshots(), singleDelete: api.deleteVariant("one") };
    }, protection);
    expect(result.deleted.ok).toBe(false);
    expect(result.variants.filter((item) => ["one", "two"].includes(item.variantId))).toHaveLength(2);
    expect(result.snapshots.some((item) => item.requirementsSnapshotId === "requirements-1")).toBe(true);
    expect(result.singleDelete.ok).toBe(false);
  });
}

test("Review Dock keeps one generation set current and Delete preserves working geometry", async ({ page }) => {
  await prepare(page);
  const ids = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const make = (x) => ({ moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#abcdef" }], cells: { [`${x},0`]: { categoryId: "space", zoneId: `z${x}` } }, zoneAssignments: { [`z${x}`]: { bubbleId: "room" } } });
    const a = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "a1", requirementsSnapshotId: a.requirementsSnapshotId, blockPlan: make(1) });
    const b = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "b1", requirementsSnapshotId: b.requirementsSnapshotId, blockPlan: make(2) });
    api.createVariant({ variantId: "b2", requirementsSnapshotId: b.requirementsSnapshotId, blockPlan: make(3) });
    api.activateVariant("b1");
    return { a: a.requirementsSnapshotId, b: b.requirementsSnapshotId };
  });
  const selector = page.getByTestId("review-variant-select");
  await expect(selector.locator("option")).toHaveCount(2);
  expect(await selector.locator("option").allTextContents()).toEqual(["b1", "b2"]);
  const geometry = await page.evaluate(() => window.BlockPlanAPI.getPlan().cells);
  await page.getByTestId("review-delete-variant").click();
  await expect(selector).toHaveValue("b2");
  await page.getByTestId("review-delete-variant").click();
  await expect(page.getByTestId("review-dock")).toBeHidden();
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(geometry);
  expect((await page.evaluate(() => window.BlockPlanAPI.listVariants())).map((item) => item.variantId)).toEqual(["a1"]);
  await page.reload();
  await expect(page.getByTestId("review-variant-select")).toHaveValue("a1");
  const reloadedGeometry = await page.evaluate(() => window.BlockPlanAPI.getPlan().cells);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("review-discard-set").click();
  await expect(page.getByTestId("review-dock")).toBeHidden();
  const discarded = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(discarded.cells).toEqual(reloadedGeometry);
  expect(discarded.generation.variants).toEqual([]);
  expect(discarded.generation.requirementsSnapshots.map((item) => item.requirementsSnapshotId)).toEqual([ids.b]);
  expect(ids.a).not.toBe(ids.b);
});

test("deleting during Review detaches unchanged geometry until Review is entered again", async ({ page }) => {
  await prepare(page);
  const expected = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const make = (x) => ({ moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#abcdef" }], cells: { [`${x},0`]: { categoryId: "space", zoneId: `z${x}` } }, zoneAssignments: { [`z${x}`]: { bubbleId: "room" } } });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "b1", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: make(1) });
    api.createVariant({ variantId: "b2", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: make(2) });
    api.activateVariant("b1");
    return { b1: api.getVariant("b1").blockPlan.cells, b2: api.getVariant("b2").blockPlan.cells };
  });

  const dock = page.getByTestId("review-dock");
  await page.getByTestId("review-toggle").click();
  await expect(dock).toContainText("Reviewing b1");
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(expected.b1);

  await page.getByTestId("review-delete-variant").click();
  expect((await page.evaluate(() => window.BlockPlanAPI.listVariants())).map((variant) => variant.variantId)).toEqual(["b2"]);
  await expect(page.getByTestId("review-variant-select")).toHaveValue("b2");
  await expect(page.locator("body")).not.toHaveClass(/review-mode/);
  await expect(dock).not.toContainText("Reviewing b2");
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(expected.b1);

  await page.getByTestId("review-toggle").click();
  await expect(dock).toContainText("Reviewing b2");
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(expected.b2);
});

test("Discard Set confirms, is atomic in the UI, and surfaces blocked reasons", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const make = (x) => ({ moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#abcdef" }], cells: { [`${x},0`]: { categoryId: "space", zoneId: `z${x}` } }, zoneAssignments: { [`z${x}`]: { bubbleId: "room" } } });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "protected", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: make(4) });
    api.createVariant({ variantId: "peer", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: make(5) });
    api.createReview({ variantId: "protected", decision: "accept" });
    api.activateVariant("protected");
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByTestId("review-discard-set").click();
  expect(await page.evaluate(() => window.BlockPlanAPI.listVariants())).toHaveLength(2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("review-discard-set").click();
  await expect(page.getByTestId("review-lifecycle-error")).toContainText("Review history");
  expect(await page.evaluate(() => window.BlockPlanAPI.listVariants())).toHaveLength(2);
});
