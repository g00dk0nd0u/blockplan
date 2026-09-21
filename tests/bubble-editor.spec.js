const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

async function connectorScreenPoint(connector) {
  return connector.evaluate((pathElement) => {
    const point = pathElement.getPointAtLength(pathElement.getTotalLength() / 2);
    const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(pathElement.getScreenCTM());
    return { x: screenPoint.x, y: screenPoint.y };
  });
}

test("Bubble Editor supports direct manipulation and semantic connectors", async ({ page }, testInfo) => {
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.locator("[data-testid='planning-canvas']")).toBeVisible();
  await page.locator("[data-testid='mode-bubble']").click();
  const workspace = page.locator("[data-testid='bubble-workspace']");
  await expect(workspace).toBeVisible();
  await expect(page.locator("[data-testid='dashboard']")).toBeHidden();
  await expect(page.locator("[data-testid='tool-select']")).toBeHidden();
  await expect(page.locator("[data-testid='export-png']")).toBeHidden();

  const bounds = await workspace.boundingBox();
  await page.mouse.dblclick(bounds.x + 310, bounds.y + 280);
  const nameInput = page.locator("[data-testid='bubble-edit-name']");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("Bedroom");
  await nameInput.press("Enter");

  const first = page.locator(".bubble-node").filter({ hasText: "Bedroom" });
  await expect(first).toContainText("10㎡");
  await expect(first).toContainText("×1");
  await first.locator("[data-field='size']").dblclick();
  await page.locator("[data-testid='bubble-edit-size']").fill("12");
  await page.locator("[data-testid='bubble-edit-size']").press("Enter");
  await first.locator("[data-field='quantity']").dblclick();
  await page.locator("[data-testid='bubble-edit-quantity']").fill("7");
  await page.locator("[data-testid='bubble-edit-quantity']").press("Enter");
  await expect(first).toContainText("Bedroom");
  await expect(first).toContainText("12㎡");
  await expect(first).toContainText("×7");

  await page.mouse.dblclick(bounds.x + 740, bounds.y + 390);
  await page.locator("[data-testid='bubble-edit-name']").fill("Hall");
  await page.locator("[data-testid='bubble-edit-name']").press("Enter");
  const second = page.locator(".bubble-node").filter({ hasText: "Hall" });

  await first.click();
  const port = first.locator("[data-testid='bubble-port-right']");
  const portBox = await port.boundingBox();
  const secondBox = await second.boundingBox();
  await page.mouse.move(portBox.x + portBox.width / 2, portBox.y + portBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 8 });
  await page.mouse.up();

  const connector = page.locator(".bubble-wire-hit");
  await expect(connector).toHaveCount(1);
  const beforePath = await connector.getAttribute("d");
  const idsBefore = await page.evaluate(() => {
    const value = window.BlockPlanAPI.getBubbleDiagram().connectors[0];
    return [value.fromBubbleId, value.toBubbleId];
  });
  const movedBox = await second.boundingBox();
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedBox.x + 40, movedBox.y - 40, { steps: 4 });
  const duringDragPath = await connector.getAttribute("d");
  expect(duringDragPath).not.toBe(beforePath);
  await page.mouse.move(movedBox.x + 80, movedBox.y - 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => connector.getAttribute("d")).not.toBe(beforePath);
  expect(await page.evaluate(() => {
    const value = window.BlockPlanAPI.getBubbleDiagram().connectors[0];
    return [value.fromBubbleId, value.toBubbleId];
  })).toEqual(idsBefore);

  const connectorPoint = await connectorScreenPoint(connector);
  await page.mouse.click(connectorPoint.x, connectorPoint.y);
  await expect(page.locator("[data-testid='connector-popover']")).toBeVisible();
  await page.locator("[data-testid='connector-relation']").selectOption("separate");
  await expect(page.locator("[data-testid='connector-popover']")).toBeVisible();
  await page.locator("[data-testid='connector-priority']").selectOption("required");
  await expect(page.locator("[data-testid='connector-popover']")).toBeVisible();
  await expect(page.locator(".bubble-wire.relation-separate.priority-required")).toHaveCount(1);

  await page.mouse.wheel(0, -240);
  await expect(page.locator("#bubbleScene")).toHaveCSS("transform", /matrix/);
  await expect(page.locator(".bubble-wire-hit")).toHaveCount(1);

  const beforePan = await page.evaluate(() => ({
    bubbles: window.BlockPlanAPI.getBubbleDiagram().bubbles,
    endpoints: window.BlockPlanAPI.getBubbleDiagram().connectors.map(({ fromBubbleId, toBubbleId }) => ({ fromBubbleId, toBubbleId }))
  }));
  const beforePanTransform = await page.locator("#bubbleScene").evaluate((element) => getComputedStyle(element).transform);
  const beforePanPath = await connector.getAttribute("d");
  await page.keyboard.down("Space");
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 170, bounds.y + 145, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const afterPanTransform = await page.locator("#bubbleScene").evaluate((element) => getComputedStyle(element).transform);
  expect(afterPanTransform).not.toBe(beforePanTransform);
  expect(await connector.getAttribute("d")).toBe(beforePanPath);
  expect(await page.evaluate(() => ({
    bubbles: window.BlockPlanAPI.getBubbleDiagram().bubbles,
    endpoints: window.BlockPlanAPI.getBubbleDiagram().connectors.map(({ fromBubbleId, toBubbleId }) => ({ fromBubbleId, toBubbleId }))
  }))).toEqual(beforePan);

  const artifactDirectory = path.resolve(__dirname, "../output");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const screenshot = await page.screenshot({ path: path.join(artifactDirectory, "bubble-mode.png"), fullPage: true });
  await testInfo.attach("bubble-mode", { body: screenshot, contentType: "image/png" });

  const savedDiagram = await page.evaluate(() => window.BlockPlanAPI.getBubbleDiagram());
  await page.locator("[data-testid='save-json']").click();
  await page.reload();
  await page.locator("[data-testid='mode-bubble']").click();
  expect(await page.evaluate(() => window.BlockPlanAPI.getBubbleDiagram())).toEqual(savedDiagram);
  await expect(page.locator(".bubble-wire-hit")).toHaveCount(1);

  await second.click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".bubble-wire-hit")).toHaveCount(0);
  expect((await page.evaluate(() => window.BlockPlanAPI.getBubbleDiagram())).connectors).toEqual([]);

  const paint = await page.evaluate(() => window.BlockPlanAPI.paintRect({ x: 1, y: 1, width: 2, height: 2, categoryId: "office", zoneId: "regression" }));
  expect(paint.ok).toBe(true);
  await page.locator("[data-testid='mode-block']").click();
  await expect(page.locator("[data-testid='planning-canvas']")).toBeVisible();
  expect(await page.evaluate(() => window.BlockPlanAPI.getZones().find((zone) => zone.zoneId === "regression").cellKeys.length)).toBe(4);
});

test("normal JSON Load restores the visible Bubble Diagram", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => {
    localStorage.clear();
    window.BlockPlanAPI.setBubbleDiagram({
      version: 1,
      bubbles: [
        { id: "bedroom", name: "Bedroom", type: "space", size: { value: 12, unit: "sqm" }, quantity: 7, position: { x: 260, y: 220 }, metadata: {} },
        { id: "hall", name: "Hall", type: "space", size: { value: 18, unit: "sqm" }, quantity: 1, position: { x: 650, y: 360 }, metadata: {} }
      ],
      connectors: [
        { id: "bedroom-hall", fromBubbleId: "bedroom", toBubbleId: "hall", relationType: "near", priority: "preferred", direction: null, metadata: {} }
      ]
    });
  });
  const savedPlan = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  await page.evaluate(() => window.BlockPlanAPI.setBubbleDiagram({ version: 1, bubbles: [], connectors: [] }));

  await page.locator("[data-testid='load-json-input']").setInputFiles({
    name: "bubble-plan.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(savedPlan))
  });
  await expect(page.locator("[data-testid='save-status']")).toHaveText("JSON loaded");
  await page.locator("[data-testid='mode-bubble']").click();

  const bedroom = page.locator("[data-testid='bubble-bedroom']");
  const hall = page.locator("[data-testid='bubble-hall']");
  await expect(bedroom).toContainText("Bedroom");
  await expect(bedroom).toContainText("12㎡");
  await expect(bedroom).toContainText("×7");
  await expect(bedroom).toHaveCSS("left", "260px");
  await expect(bedroom).toHaveCSS("top", "220px");
  await expect(hall).toContainText("Hall");
  await expect(hall).toContainText("18㎡");
  await expect(hall).toContainText("×1");
  await expect(hall).toHaveCSS("left", "650px");
  await expect(hall).toHaveCSS("top", "360px");
  await expect(page.locator("[data-testid='connector-bedroom-hall']")).toHaveCount(1);
});
