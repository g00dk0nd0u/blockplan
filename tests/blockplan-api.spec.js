const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

test("BlockPlan hidden API can create and validate a plan", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.locator("[data-testid='planning-canvas']")).toBeVisible();

  await expect.poll(() => page.evaluate(() => window.BlockPlanAPI && window.BlockPlanAPI.version)).toBe(1);

  const summary = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.setModuleSize(3600);
    const category = api.addCategory({ id: "lab", name: "Lab", color: "#7BA7C7" });
    if (!category.ok) return category;
    const a = api.paintRect({ x: 0, y: 0, width: 4, height: 3, categoryId: "office", zoneId: "office-a" });
    const b = api.paintRect({ x: 5, y: 0, width: 2, height: 3, categoryId: "meeting", zoneId: "meeting-a" });
    const c = api.paintRect({ x: 0, y: 4, width: 3, height: 2, categoryId: "lab", zoneId: "lab-a" });
    if (!a.ok) return a;
    if (!b.ok) return b;
    if (!c.ok) return c;
    return api.getStateSummary();
  });
  expect(summary.dashboard.office.cellCount).toBe(12);
  expect(summary.dashboard.meeting.cellCount).toBe(6);
  expect(summary.dashboard.lab.cellCount).toBe(6);
  expect(summary.zones).toHaveLength(3);

  const validation = await page.evaluate(() => window.BlockPlanAPI.validatePlan());
  expect(validation.ok).toBe(true);
  expect(validation.cellCount).toBe(24);
  expect(validation.zoneCount).toBe(3);

  await page.evaluate(() => window.BlockPlanAPI.fitToView());
  await page.locator("[data-testid='planning-canvas']").screenshot({ path: "test-results/blockplan-api-sample.png" });

  const dataUrl = await page.evaluate(() => window.BlockPlanAPI.exportPngDataUrl());
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);

  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/blockplan-api-summary.json", JSON.stringify(summary, null, 2));

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.BlockPlanAPI && window.BlockPlanAPI.version)).toBe(1);
  const restored = await page.evaluate(() => window.BlockPlanAPI.getStateSummary());
  expect(restored.dashboard.office.cellCount).toBe(12);
  expect(restored.dashboard.meeting.cellCount).toBe(6);
  expect(restored.dashboard.lab.cellCount).toBe(6);
});
