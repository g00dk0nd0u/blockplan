const { test, expect } = require("@playwright/test");
const path = require("path");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;
const unassigned = { id: "unassigned", name: "Unassigned", color: "#B8B4AE" };

const bubbles = [
  { id: "work", name: "Work Area", type: "space", size: { value: 6, unit: "sqm" }, quantity: 1, position: { x: 10, y: 10 } },
  { id: "meeting", name: "Meeting", type: "space", size: { value: 4, unit: "sqm" }, quantity: 2, position: { x: 20, y: 20 } },
  { id: "support", name: "Support", type: "space", size: { value: 4, unit: "sqm" }, quantity: 1, position: { x: 30, y: 30 } },
  { id: "reception", name: "Reception", type: "space", size: { value: 4, unit: "sqm" }, quantity: 1, position: { x: 40, y: 40 } }
];

test("fresh and cleared plans use only the active Unassigned category", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.locator(".category-name")).toHaveText(["Unassigned"]);
  await expect(page.locator('.dashboard-category-row[data-category-id="unassigned"]')).toHaveClass(/is-active/);

  await page.evaluate(() => window.BlockPlanAPI.addCategory({ id: "manual", name: "Manual", color: "#123456" }));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("clear-plan").click();
  expect((await page.evaluate(() => window.BlockPlanAPI.getPlan())).categories).toEqual([unassigned]);
  await expect(page.locator('.dashboard-category-row[data-category-id="unassigned"]')).toHaveClass(/is-active/);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  expect((await page.evaluate(() => window.BlockPlanAPI.getPlan())).categories).toEqual([
    unassigned,
    { id: "manual", name: "Manual", color: "#123456" }
  ]);
});

test("Clear Plan undo restores a modified default category without geometry", async ({ page }) => {
  await page.goto(appUrl);
  const modified = { id: "unassigned", name: "Not Yet Assigned", color: "#778899" };
  await page.evaluate((modified) => {
    const plan = window.BlockPlanAPI.getPlan();
    plan.categories = [modified];
    window.BlockPlanAPI.setPlan(plan);
  }, modified);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("clear-plan").click();
  expect((await page.evaluate(() => window.BlockPlanAPI.getPlan())).categories).toEqual([unassigned]);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  expect((await page.evaluate(() => window.BlockPlanAPI.getPlan())).categories).toEqual([modified]);
});

test("explicit categories in an old saved plan load unchanged", async ({ page }) => {
  const oldCategories = [unassigned, { id: "office", name: "Office", color: "#AABB9C" }, { id: "meeting", name: "Meeting", color: "#90B0C4" }];
  await page.addInitScript(({ oldCategories }) => localStorage.setItem("blockplan.currentPlan.v1", JSON.stringify({ version: 1, moduleSizeMm: 3600, categories: oldCategories, cells: {}, bubbleDiagram: { version: 1, bubbles: [], connectors: [] } })), { oldCategories });
  await page.goto(appUrl);
  expect((await page.evaluate(() => window.BlockPlanAPI.getPlan())).categories).toEqual(oldCategories);
});

test("Bubble projection is deterministic and generation assigns each Zone to its Bubble category", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate((bubbles) => {
    const api = window.BlockPlanAPI;
    api.setModuleSize(1000);
    api.setBubbleDiagram({ version: 1, bubbles, connectors: [] });
    const manualBefore = api.getPlan().categories;
    const first = window.BlockPlanAgent.callTool("prepare_generation_request", { requestedVariantCount: 1, generationFrame: { version: 1, bounds: { x: 0, y: 0, width: 12, height: 8 } } });
    const secondColors = GenerationModel.categoriesFromBubbles(bubbles).map(({ id, color }) => ({ id, color }));
    const changed = api.getBubbleDiagram();
    changed.bubbles[0].name = "Renamed Later";
    api.setBubbleDiagram(changed);
    const generated = api.generateLayoutCandidates(first.request.requirementsSnapshotId, { requestedVariantCount: 1, maxStates: 50000 });
    const candidate = generated.candidates[0];
    const submitted = api.createVariant({ requirementsSnapshotId: first.request.requirementsSnapshotId, ...candidate });
    const activation = api.activateVariant(submitted.variant.variantId);
    return {
      manualBefore,
      afterPrepare: api.getRequirementsSnapshot(first.request.requirementsSnapshotId).metadata.generationContext.categories,
      firstColors: first.request.categories.map(({ id, color }) => ({ id, color })),
      secondColors,
      candidate,
      activation,
      dashboard: api.getDashboard()
    };
  }, bubbles);

  expect(result.manualBefore).toEqual([unassigned]);
  expect(result.afterPrepare.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "unassigned", name: "Unassigned" }, { id: "bubble::work", name: "Work Area" },
    { id: "bubble::meeting", name: "Meeting" }, { id: "bubble::support", name: "Support" },
    { id: "bubble::reception", name: "Reception" }
  ]);
  expect(result.firstColors).toEqual(result.secondColors);
  expect(result.candidate).toBeTruthy();
  const { cells, zoneAssignments } = result.candidate.blockPlan;
  for (const [zoneId, assignment] of Object.entries(zoneAssignments)) {
    const zoneCells = Object.values(cells).filter((cell) => cell.zoneId === zoneId);
    expect(zoneCells.length).toBeGreaterThan(0);
    expect(new Set(zoneCells.map((cell) => cell.categoryId))).toEqual(new Set([`bubble::${assignment.bubbleId}`]));
  }
  expect(Object.values(cells).some((cell) => cell.categoryId !== "unassigned")).toBe(true);
  expect(Object.entries(zoneAssignments).filter(([, assignment]) => assignment.bubbleId === "meeting")).toHaveLength(2);
  expect(new Set(Object.values(cells).filter((cell) => zoneAssignments[cell.zoneId].bubbleId === "meeting").map((cell) => cell.categoryId))).toEqual(new Set(["bubble::meeting"]));
  expect(result.activation.plan.categories[1].name).toBe("Work Area");
  expect(result.activation.plan.categories.map((category) => category.name)).toEqual(["Unassigned", "Work Area", "Meeting", "Support", "Reception"]);
  expect(result.dashboard.unassigned).toEqual({ cellCount: 0, zoneCount: 0, areaSqm: 0 });
  for (const bubble of bubbles) {
    const stats = result.dashboard[`bubble::${bubble.id}`];
    expect(stats.cellCount).toBeGreaterThan(0);
    expect(stats.zoneCount).toBe(bubble.quantity);
    expect(stats.areaSqm).toBe(stats.cellCount);
  }
  await expect(page.locator(".dashboard-category")).toHaveText(["Unassigned", "Work Area", "Meeting", "Support", "Reception"]);
});

test("legacy generator categories fall back safely to Unassigned", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const problem = { version: 1, requirementsSnapshotId: "legacy", moduleSizeMm: 1000, categories: [{ id: "legacy", name: "Legacy", color: "#123456" }], spaces: [{ bubbleId: "room", type: "space", targetSize: { value: 1, unit: "sqm" }, quantity: 1 }], relationships: [], rulePack: null };
    const snapshot = { requirementsSnapshotId: "legacy", bubbles: [{ id: "room", name: "Room", type: "space", size: { value: 1, unit: "sqm" }, quantity: 1 }], connectors: [] };
    return window.LayoutGenerator.generateCandidates(problem, snapshot, { requestedVariantCount: 1, maxStates: 100 });
  });
  expect(result.candidates[0].blockPlan.categories).toContainEqual(unassigned);
  expect(new Set(Object.values(result.candidates[0].blockPlan.cells).map((cell) => cell.categoryId))).toEqual(new Set(["unassigned"]));
});

test("generation preserves Bubble IDs containing the instance delimiter", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setModuleSize(1000);
    api.setBubbleDiagram({ version: 1, bubbles: [
      { id: "north::work", name: "North Work", type: "space", size: { value: 4, unit: "sqm" }, quantity: 1, position: { x: 10, y: 10 } }
    ], connectors: [] });
    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", {
      requestedVariantCount: 1,
      generationFrame: { version: 1, bounds: { x: 0, y: 0, width: 6, height: 6 } }
    });
    const generated = api.generateLayoutCandidates(prepared.request.requirementsSnapshotId, { requestedVariantCount: 1, maxStates: 1000 });
    const candidate = generated.candidates[0];
    const created = api.createVariant({ requirementsSnapshotId: prepared.request.requirementsSnapshotId, ...candidate });
    return { generated, candidate, created, validation: created.ok ? api.validateVariantAgainstDiagram(created.variant.variantId) : null };
  });

  expect(result.generated.candidates).toHaveLength(1);
  expect(Object.values(result.candidate.blockPlan.zoneAssignments)).toEqual([{ bubbleId: "north::work" }]);
  expect(result.candidate.blockPlan.categories).toContainEqual(expect.objectContaining({ id: "bubble::north::work", name: "North Work" }));
  expect(new Set(Object.values(result.candidate.blockPlan.cells).map((cell) => cell.categoryId))).toEqual(new Set(["bubble::north::work"]));
  expect(result.created.ok).toBe(true);
  expect(result.validation.dataErrors).toEqual([]);
  expect(result.validation.hardViolations).toEqual([]);
});
