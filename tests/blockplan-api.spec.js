const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

test("BlockPlan hidden API can create and validate a plan", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.locator("[data-testid='planning-canvas']")).toBeVisible();

  const apiVersion = await page.evaluate(() => window.BlockPlanAPI && window.BlockPlanAPI.version);
  expect(apiVersion).toBe(1);

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
  // Read methods intentionally return direct data (not { ok: true, value }) under the current API contract.
  expect(summary).not.toHaveProperty("ok");
  expect(summary).toHaveProperty("moduleSizeMm", 3600);
  expect(summary).toHaveProperty("dashboard");
  expect(summary).toHaveProperty("bounds");
  expect(summary).toHaveProperty("zones");
  expect(summary.dashboard.office.cellCount).toBe(12);
  expect(summary.dashboard.meeting.cellCount).toBe(6);
  expect(summary.dashboard.lab.cellCount).toBe(6);
  expect(summary.zones).toHaveLength(3);

  const duplicateCopy = await page.evaluate(() => {
    const beforeZones = window.BlockPlanAPI.getZones();
    const result = window.BlockPlanAPI.copyZone({ zoneId: "office-a", dx: 10, dy: 0, newZoneId: "meeting-a" });
    const afterZones = window.BlockPlanAPI.getZones();
    return { result, beforeZones, afterZones };
  });
  expect(duplicateCopy.result.ok).toBe(false);
  expect(duplicateCopy.afterZones).toHaveLength(duplicateCopy.beforeZones.length);
  expect(duplicateCopy.afterZones.find((zone) => zone.zoneId === "office-a").cellKeys).toHaveLength(12);
  expect(duplicateCopy.afterZones.find((zone) => zone.zoneId === "meeting-a").cellKeys).toHaveLength(6);

  const validation = await page.evaluate(() => window.BlockPlanAPI.validatePlan());
  expect(validation.ok).toBe(true);
  expect(validation.cellCount).toBe(24);
  expect(validation.zoneCount).toBe(3);

  await page.evaluate(() => window.BlockPlanAPI.fitToView());
  await page.locator("[data-testid='planning-canvas']").screenshot({ path: "test-results/blockplan-api-sample.png" });

  const dataUrl = await page.evaluate(() => window.BlockPlanAPI.exportPngDataUrl());
  expect(typeof dataUrl).toBe("string");
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);

  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/blockplan-api-summary.json", JSON.stringify(summary, null, 2));

  await page.reload();
  const reloadedApiVersion = await page.evaluate(() => window.BlockPlanAPI && window.BlockPlanAPI.version);
  expect(reloadedApiVersion).toBe(1);
  const restored = await page.evaluate(() => window.BlockPlanAPI.getStateSummary());
  expect(restored).not.toHaveProperty("ok");
  expect(restored.dashboard.office.cellCount).toBe(12);
  expect(restored.dashboard.meeting.cellCount).toBe(6);
  expect(restored.dashboard.lab.cellCount).toBe(6);
});

test("old plans normalize an empty Bubble Diagram without changing geometry", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => window.BlockPlanAPI.setPlan({
    version: 1,
    moduleSizeMm: 3600,
    categories: [{ id: "office", name: "Office", color: "#AABB9C" }],
    cells: { "2,3": { categoryId: "office", zoneId: "office-old" } },
    underlay: null
  }));
  expect(result.ok).toBe(true);
  expect(result.plan.bubbleDiagram).toEqual({ version: 1, bubbles: [], connectors: [] });
  expect(await page.evaluate(() => window.BlockPlanAPI.getZones())).toEqual([
    expect.objectContaining({ zoneId: "office-old", cellKeys: ["2,3"] })
  ]);

  await page.reload();
  const restored = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(restored.bubbleDiagram).toEqual({ version: 1, bubbles: [], connectors: [] });
  expect(restored.cells["2,3"]).toEqual({ categoryId: "office", zoneId: "office-old" });
});

test("Bubble and Connector CRUD round-trips semantic and presentation state", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [], connectors: [] });
    const bedroom = api.addBubble({
      id: "bedroom",
      name: "Bedroom",
      type: "space",
      size: { value: 12, unit: "sqm" },
      quantity: 7,
      position: { x: 100, y: 200 },
      metadata: { group: "private" }
    });
    const hall = api.addBubble({
      id: "hall",
      name: "Hall",
      type: "circulation",
      size: { value: 20, unit: "sqm" },
      position: { x: 300, y: 200 }
    });
    const connected = api.connectBubbles({
      id: "bedroom-hall",
      fromBubbleId: "bedroom",
      toBubbleId: "hall",
      relationType: "near",
      priority: "preferred",
      metadata: {}
    });
    const moved = api.updateBubble({ id: "bedroom", position: { x: 800, y: -40 } });
    const updated = api.updateConnector({ id: "bedroom-hall", relationType: "adjacent", priority: "required" });
    return { bedroom, hall, connected, moved, updated, diagram: api.getBubbleDiagram(), plan: api.getPlan() };
  });

  expect(result.bedroom.ok).toBe(true);
  expect(result.hall.ok).toBe(true);
  expect(result.connected.ok).toBe(true);
  expect(result.moved.bubble).toMatchObject({ quantity: 7, position: { x: 800, y: -40 } });
  expect(result.updated.connector).toMatchObject({ relationType: "adjacent", priority: "required" });
  expect(result.diagram.bubbles.find((bubble) => bubble.id === "bedroom")).toMatchObject({
    quantity: 7,
    size: { value: 12, unit: "sqm" },
    position: { x: 800, y: -40 }
  });
  expect(result.diagram.connectors[0]).toMatchObject({
    fromBubbleId: "bedroom",
    toBubbleId: "hall",
    relationType: "adjacent",
    priority: "required"
  });
  expect(result.plan.bubbleDiagram).toEqual(result.diagram);

  const restored = await page.evaluate((savedPlan) => {
    const set = window.BlockPlanAPI.setPlan(JSON.stringify(savedPlan));
    return { set, diagram: window.BlockPlanAPI.getBubbleDiagram() };
  }, result.plan);
  expect(restored.set.ok).toBe(true);
  expect(restored.diagram).toEqual(result.diagram);

  const removedConnector = await page.evaluate(() => window.BlockPlanAPI.removeConnector("bedroom-hall"));
  expect(removedConnector).toEqual({ ok: true, connectorId: "bedroom-hall" });
  expect(await page.evaluate(() => window.BlockPlanAPI.getBubbleDiagram().connectors)).toEqual([]);
});

test("removing a Bubble atomically removes attached Connectors", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [], connectors: [] });
    ["a", "b", "c"].forEach((id, index) => api.addBubble({
      id,
      name: id.toUpperCase(),
      size: { value: 10, unit: "sqm" },
      position: { x: index * 10, y: 0 }
    }));
    api.connectBubbles({ id: "a-b", fromBubbleId: "a", toBubbleId: "b", relationType: "near", priority: "optional" });
    api.connectBubbles({ id: "b-c", fromBubbleId: "b", toBubbleId: "c", relationType: "separate", priority: "required" });
    const removed = api.removeBubble("b");
    return { removed, diagram: api.getBubbleDiagram(), validation: api.validateBubbleDiagram() };
  });
  expect(result.removed).toEqual({ ok: true, bubbleId: "b", removedConnectorIds: ["a-b", "b-c"] });
  expect(result.diagram.bubbles.map((bubble) => bubble.id)).toEqual(["a", "c"]);
  expect(result.diagram.connectors).toEqual([]);
  expect(result.validation).toEqual({ ok: true, errors: [], warnings: [] });
});

test("invalid Bubble Diagrams are rejected without mutating saved state", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [], connectors: [] });
    const before = api.getBubbleDiagram();
    const invalidBubble = api.addBubble({ id: "bad", name: "Bad", size: { value: -1, unit: "sqm" }, quantity: 0 });
    const dangling = api.connectBubbles({ id: "dangling", fromBubbleId: "missing", toBubbleId: "also-missing", relationType: "adjacent", priority: "required" });
    const malformed = api.setPlan({
      version: 1,
      moduleSizeMm: 3600,
      categories: [],
      cells: {},
      bubbleDiagram: {
        version: 1,
        bubbles: [{ id: "same", name: "A", type: "space", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 }, metadata: {} }],
        connectors: [{ id: "self", fromBubbleId: "same", toBubbleId: "same", relationType: "flow", priority: "urgent", direction: null, metadata: {} }]
      }
    });
    return { before, invalidBubble, dangling, malformed, after: api.getBubbleDiagram(), validation: api.validateBubbleDiagram() };
  });
  expect(result.invalidBubble.ok).toBe(false);
  expect(result.dangling.ok).toBe(false);
  expect(result.malformed.ok).toBe(false);
  expect(result.after).toEqual(result.before);
  expect(result.validation).toEqual({ ok: true, errors: [], warnings: [] });
});

test("normal JSON Load shares Bubble Diagram normalization and validation", async ({ page }) => {
  await page.goto(appUrl);
  const input = page.locator("[data-testid='load-json-input']");

  const oldPlan = {
    version: 1,
    moduleSizeMm: 3600,
    categories: [{ id: "office", name: "Office", color: "#AABB9C" }],
    cells: { "1,1": { categoryId: "office", zoneId: "old-zone" } },
    underlay: null
  };
  await input.setInputFiles({ name: "old-plan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(oldPlan)) });
  await expect(page.locator("[data-testid='save-status']")).toHaveText("JSON loaded");
  let loaded = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(loaded.bubbleDiagram).toEqual({ version: 1, bubbles: [], connectors: [] });
  expect(loaded.cells["1,1"]).toEqual({ categoryId: "office", zoneId: "old-zone" });

  const validPlan = {
    ...oldPlan,
    cells: { "4,5": { categoryId: "office", zoneId: "valid-zone" } },
    bubbleDiagram: {
      version: 1,
      bubbles: [
        { id: "room", name: "Room", size: { value: 15, unit: "sqm" } },
        { id: "hall", name: "Hall", size: { value: 8, unit: "sqm" } }
      ],
      connectors: [{ id: "room-hall", fromBubbleId: "room", toBubbleId: "hall", relationType: "near", priority: "preferred" }]
    }
  };
  await input.setInputFiles({ name: "valid-plan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(validPlan)) });
  await expect(page.locator("[data-testid='save-status']")).toHaveText("JSON loaded");
  loaded = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(loaded.bubbleDiagram.bubbles[0]).toMatchObject({ type: "space", quantity: 1, position: { x: 0, y: 0 }, metadata: {} });
  expect(loaded.bubbleDiagram.connectors[0]).toMatchObject({ direction: null, metadata: {} });

  const beforeInvalidLoad = loaded;
  const malformedPlan = {
    ...validPlan,
    cells: { "99,99": { categoryId: "office", zoneId: "must-not-load" } },
    bubbleDiagram: {
      version: 1,
      bubbles: [{ id: "room", name: "Room", size: { value: 15, unit: "sqm" } }],
      connectors: [{ id: "dangling", fromBubbleId: "room", toBubbleId: "missing", relationType: "near", priority: "required" }]
    }
  };
  await input.setInputFiles({ name: "malformed-plan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(malformedPlan)) });
  await expect(page.locator("[data-testid='save-status']")).toHaveText("Load failed");
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan())).toEqual(beforeInvalidLoad);
});

test("whole-diagram API canonicalizes optional fields but rejects missing semantics", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const accepted = api.setBubbleDiagram({
      version: 1,
      bubbles: [
        { id: "a", name: "A", size: { value: 10, unit: "sqm" } },
        { id: "b", name: "B", size: { value: 12, unit: "sqm" } }
      ],
      connectors: [{ id: "a-b", fromBubbleId: "a", toBubbleId: "b", relationType: "adjacent", priority: "required" }]
    });
    const beforeFailures = api.getBubbleDiagram();
    const missingBubbleId = api.addBubble({ name: "No ID", size: { value: 1, unit: "sqm" } });
    const missingBubbleName = api.setBubbleDiagram({
      version: 1,
      bubbles: [{ id: "nameless", size: { value: 1, unit: "sqm" } }],
      connectors: []
    });
    const missingBubbleSize = api.addBubble({ id: "no-size", name: "No size" });
    const missingRelation = api.connectBubbles({ id: "bad-connector", fromBubbleId: "a", toBubbleId: "b", priority: "required" });
    return { accepted, beforeFailures, missingBubbleId, missingBubbleName, missingBubbleSize, missingRelation, afterFailures: api.getBubbleDiagram() };
  });

  expect(result.accepted.ok).toBe(true);
  expect(result.accepted.bubbleDiagram.bubbles).toEqual([
    { id: "a", name: "A", type: "space", size: { value: 10, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 }, metadata: {} },
    { id: "b", name: "B", type: "space", size: { value: 12, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 }, metadata: {} }
  ]);
  expect(result.accepted.bubbleDiagram.connectors[0]).toEqual({
    id: "a-b",
    fromBubbleId: "a",
    toBubbleId: "b",
    relationType: "adjacent",
    priority: "required",
    direction: null,
    metadata: {}
  });
  expect(result.missingBubbleId.ok).toBe(false);
  expect(result.missingBubbleName.ok).toBe(false);
  expect(result.missingBubbleSize.ok).toBe(false);
  expect(result.missingRelation.ok).toBe(false);
  expect(result.afterFailures).toEqual(result.beforeFailures);
});
