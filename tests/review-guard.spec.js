const { test, expect } = require("@playwright/test");
const path = require("path");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

async function seedReviewScenario(page) {
  await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.paintRect({ x: 7, y: 7, width: 1, height: 1, categoryId: "office", zoneId: "manual" });
    api.setBubbleDiagram({
      version: 1,
      bubbles: [{ id: "room", name: "Room", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } }],
      connectors: []
    });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({
      variantId: "review-target",
      requirementsSnapshotId: snapshot.requirementsSnapshotId,
      blockPlan: {
        moduleSizeMm: 1000,
        categories: [{ id: "space", name: "Space", color: "#AABB9C" }],
        cells: { "2,0": { categoryId: "space", zoneId: "review-zone" } },
        zoneAssignments: { "review-zone": { bubbleId: "room" } }
      }
    });
  });
  await page.getByTestId("review-toggle").click();
  await expect(page.getByTestId("review-dock")).toContainText("Reviewing review-target");
}

test("Review mode blocks undo and plan-replacing file actions", async ({ page }) => {
  await page.goto(appUrl);
  await seedReviewScenario(page);

  const reviewedCells = await page.evaluate(() => window.BlockPlanAPI.getPlan().cells);
  expect(Object.keys(reviewedCells)).toEqual(["2,0"]);

  const undoShortcut = process.platform === "darwin" ? "Meta+z" : "Control+z";
  await page.keyboard.press(undoShortcut);
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(reviewedCells);
  await expect(page.getByTestId("review-dock")).toContainText("Reviewing review-target");

  await expect(page.getByTestId("clear-plan")).toBeDisabled();
  await expect(page.getByTestId("load-json")).toBeDisabled();

  await page.evaluate(() => {
    const clear = document.getElementById("clearButton");
    clear.disabled = false;
    clear.click();
  });
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(reviewedCells);

  const replacement = {
    version: 1,
    moduleSizeMm: 3600,
    categories: [{ id: "office", name: "Office", color: "#AABB9C" }],
    cells: { "9,9": { categoryId: "office", zoneId: "replacement" } },
    underlay: null,
    bubbleDiagram: { version: 1, bubbles: [], connectors: [] },
    generation: { version: 1, requirementsSnapshots: [], variants: [] },
    review: { version: 1, reviews: [] }
  };
  await page.getByTestId("load-json-input").setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement))
  });
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(reviewedCells);
  await expect(page.getByTestId("review-dock")).toContainText("Reviewing review-target");

  await page.getByTestId("review-toggle").click();
  await expect(page.getByTestId("clear-plan")).toBeEnabled();
  await expect(page.getByTestId("load-json")).toBeEnabled();
});

test("Review-mode zone clicks do not consume an Undo snapshot", async ({ page }) => {
  await page.goto(appUrl);
  await seedReviewScenario(page);

  const before = await page.evaluate(() => patchUndoStack.length);
  const canvas = page.getByTestId("planning-canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const after = await page.evaluate(() => patchUndoStack.length);
  expect(after).toBe(before);
});
