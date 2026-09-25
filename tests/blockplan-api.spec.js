const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

test("BlockPlan hidden API can create and validate a plan", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.locator("[data-testid='planning-canvas']")).toBeVisible();

  const apiVersion = await page.evaluate(() => window.BlockPlanAPI && window.BlockPlanAPI.version);
  expect(apiVersion).toBe(1);
  expect(await page.evaluate(() => typeof window.BlockPlanAPI.createVariants)).toBe("function");
  expect(await page.evaluate(() => typeof window.BlockPlanAPI.deleteVariantSet)).toBe("function");
  expect(await page.evaluate(() => [typeof window.BlockPlanAPI.getLayoutProblem, typeof window.BlockPlanAPI.evaluateVariantLayout, typeof window.BlockPlanAPI.generateLayoutCandidates])).toEqual(["function", "function", "function"]);

  const summary = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.setModuleSize(3600);
    api.addCategory({ id: "office", name: "Office", color: "#AABB9C" });
    api.addCategory({ id: "meeting", name: "Meeting", color: "#90B0C4" });
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
  expect(result.plan.generation).toEqual({ version: 1, requirementsSnapshots: [], variants: [] });
  expect(result.plan.review).toEqual({ version: 1, reviews: [] });
  expect(await page.evaluate(() => window.BlockPlanAPI.getZones())).toEqual([
    expect.objectContaining({ zoneId: "office-old", cellKeys: ["2,3"] })
  ]);

  await page.reload();
  const restored = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(restored.bubbleDiagram).toEqual({ version: 1, bubbles: [], connectors: [] });
  expect(restored.cells["2,3"]).toEqual({ categoryId: "office", zoneId: "office-old" });
});

test("Review history is append-only, validated, cloned, persisted, and exposed as iteration context", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const bubble = (id) => ({ id, name: id, size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } });
    const blockPlan = (zoneId) => ({
      moduleSizeMm: 1000,
      categories: [{ id: "space", name: "Space", color: "#AABB9C" }],
      cells: { "0,0": { categoryId: "space", zoneId } },
      zoneAssignments: { [zoneId]: { bubbleId: "room" } }
    });
    api.setBubbleDiagram({ version: 1, bubbles: [bubble("room")], connectors: [] });
    const firstSnapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "root", requirementsSnapshotId: firstSnapshot.requirementsSnapshotId, blockPlan: blockPlan("root-zone") });
    api.createVariant({ variantId: "child", parentVariantId: "root", requirementsSnapshotId: firstSnapshot.requirementsSnapshotId, blockPlan: blockPlan("child-zone") });
    api.createVariant({ variantId: "peer", requirementsSnapshotId: firstSnapshot.requirementsSnapshotId, blockPlan: blockPlan("peer-zone") });
    api.setBubbleDiagram({ version: 1, bubbles: [bubble("other")], connectors: [] });
    const secondSnapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "unrelated", requirementsSnapshotId: secondSnapshot.requirementsSnapshotId, blockPlan: {
      moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#AABB9C" }],
      cells: { "3,3": { categoryId: "space", zoneId: "other-zone" } }, zoneAssignments: { "other-zone": { bubbleId: "other" } }
    } });
    const accepted = api.createReview({ reviewId: "review-a", variantId: "root", requirementsSnapshotId: "ignored", decision: "accept", good: " clear plan \n\n usable ", problems: ["", "tight"], nextInstructions: "", createdAt: "2026-01-01T00:00:00.000Z" });
    accepted.review.good.push("leak");
    const iterated = api.createReview({ reviewId: "review-b", variantId: "child", decision: "iterate", nextInstructions: ["widen hall"], preferredOverVariantId: "peer", createdAt: "2026-01-02T00:00:00.000Z" });
    const rejected = api.createReview({ reviewId: "review-c", variantId: "child", decision: "reject", problems: ["blocked entry"], createdAt: "2026-01-03T00:00:00.000Z" });
    api.proposeMemoryFromReviews({ memoryId: "memory-approved", scope: "project", type: "soft-preference", statement: "Approved context memory", evidenceReviewIds: ["review-a"] });
    api.approveMemory("memory-approved");
    api.proposeMemoryFromReviews({ memoryId: "memory-candidate", scope: "project", type: "observed-pattern", statement: "Candidate context memory", evidenceReviewIds: ["review-b"] });
    api.proposeMemoryFromReviews({ memoryId: "memory-rejected", scope: "project", type: "rejected-pattern", statement: "Rejected context memory", evidenceReviewIds: ["review-c"] });
    api.rejectMemory("memory-rejected");
    const invalidVariant = api.createReview({ variantId: "missing", decision: "accept" });
    const invalidPreference = api.createReview({ variantId: "child", decision: "accept", preferredOverVariantId: "unrelated" });
    const duplicateReview = api.createReview({ reviewId: "review-a", variantId: "child", decision: "accept" });
    const listed = api.listReviews();
    listed[0].good.push("list leak");
    const context = api.getIterationContext("child");
    context.variant.blockPlan.cells["0,0"].zoneId = "context leak";
    context.relevantMemory[0].statement = "iteration context leak";
    const generationContext = api.getGenerationContext(firstSnapshot.requirementsSnapshotId);
    generationContext.relevantMemory[0].statement = "generation context leak";
    return {
      accepted, iterated, rejected, invalidVariant, invalidPreference, duplicateReview,
      stored: api.getReview("review-a"), reviews: api.listReviews(), childReviews: api.getVariantReviews("child"),
      context, generationContext,
      freshGenerationMemory: api.getGenerationContext(firstSnapshot.requirementsSnapshotId).relevantMemory,
      freshIterationMemory: api.getIterationContext("child").relevantMemory,
      storedMemory: api.getMemory("memory-approved"),
      freshVariant: api.getVariant("child"), deleteReviewed: api.deleteVariant("child"), deletePreferred: api.deleteVariant("peer"), plan: api.getPlan()
    };
  });
  expect(result.accepted.review).toMatchObject({ reviewId: "review-a", variantId: "root", requirementsSnapshotId: "requirements-1", decision: "accept", problems: ["tight"], nextInstructions: [], preferredOverVariantId: null });
  expect(result.iterated.review.decision).toBe("iterate");
  expect(result.rejected.review.decision).toBe("reject");
  expect(result.invalidVariant.ok).toBe(false);
  expect(result.invalidPreference).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("same Requirements Snapshot") }));
  expect(result.duplicateReview.ok).toBe(false);
  expect(result.stored.good).toEqual(["clear plan", "usable"]);
  expect(result.reviews).toHaveLength(3);
  expect(result.childReviews.map((review) => review.decision)).toEqual(["iterate", "reject"]);
  expect(result.deleteReviewed).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("Review history") }));
  expect(result.deletePreferred).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("Review history") }));
  expect(result.context.requirementsSnapshot.requirementsSnapshotId).toBe("requirements-1");
  expect(result.context.lineage.map((variant) => variant.variantId)).toEqual(["root", "child"]);
  expect(result.context.reviews.map((review) => review.reviewId)).toEqual(["review-a", "review-b", "review-c"]);
  expect(result.context.validation).toHaveProperty("metrics");
  expect(result.context.nextChildDefaults).toEqual({ parentVariantId: "child", requirementsSnapshotId: "requirements-1" });
  expect(result.context.reviews[0]).not.toHaveProperty("validation");
  expect(result.generationContext.relevantMemory.map((memory) => memory.memoryId)).toEqual(["memory-approved"]);
  expect(result.context.relevantMemory.map((memory) => memory.memoryId)).toEqual(["memory-approved"]);
  expect(result.freshGenerationMemory).toEqual([expect.objectContaining({ memoryId: "memory-approved", statement: "Approved context memory" })]);
  expect(result.freshIterationMemory).toEqual([expect.objectContaining({ memoryId: "memory-approved", statement: "Approved context memory" })]);
  expect(result.storedMemory.statement).toBe("Approved context memory");
  expect(result.freshVariant.blockPlan.cells["0,0"].zoneId).toBe("child-zone");
  expect(result.plan.review.reviews).toHaveLength(3);

  await page.reload();
  expect((await page.evaluate(() => window.BlockPlanAPI.getPlan())).review.reviews).toHaveLength(3);
  const roundTrip = await page.evaluate(() => {
    const saved = window.BlockPlanAPI.getPlan();
    return window.BlockPlanAPI.setPlan(JSON.stringify(saved));
  });
  expect(roundTrip.ok).toBe(true);
  expect(roundTrip.plan.review.reviews.map((review) => review.reviewId)).toEqual(["review-a", "review-b", "review-c"]);
});

test("compact Review UI activates Variants, blocks geometry edits, and keeps zoom and pan available", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [{ id: "room", name: "Room", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } }], connectors: [] });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    const blockPlan = (x) => ({ moduleSizeMm: 1000, categories: [{ id: "space", name: "Space", color: "#AABB9C" }], cells: { [`${x},0`]: { categoryId: "space", zoneId: `zone-${x}` } }, zoneAssignments: { [`zone-${x}`]: { bubbleId: "room" } } });
    api.createVariant({ variantId: "first", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: blockPlan(0) });
    api.createVariant({ variantId: "second", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: blockPlan(2) });
  });
  const dock = page.getByTestId("review-dock");
  await expect(dock).toBeVisible();
  await page.getByTestId("tool-select").click();
  await page.keyboard.press("b");
  await page.getByTestId("review-variant-select").selectOption("second");
  await page.getByTestId("review-toggle").click();
  await expect(dock).toContainText("Reviewing second");
  expect(await page.evaluate(() => Object.keys(window.BlockPlanAPI.getPlan().cells))).toEqual(["2,0"]);

  const before = await page.evaluate(() => window.BlockPlanAPI.getPlan().cells);
  const canvas = page.getByTestId("planning-canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => window.BlockPlanAPI.getPlan().cells)).toEqual(before);

  const zoomBefore = await page.locator("#zoomStatus").textContent();
  await canvas.hover();
  await page.mouse.wheel(0, -100);
  await expect(page.locator("#zoomStatus")).not.toHaveText(zoomBefore);
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 140, box.y + 130);
  await page.mouse.up({ button: "middle" });

  await page.getByTestId("review-iterate").click();
  await dock.screenshot({ path: "test-results/review-dock.png" });
  await page.locator("[data-review-field='good']").fill("Works\n\nCompact");
  await page.locator("[data-review-field='nextInstructions']").fill("Try a wider entry");
  await page.locator("[data-review-field='preferredOverVariantId']").selectOption("first");
  await page.getByTestId("review-save").click();
  expect(await page.evaluate(() => window.BlockPlanAPI.listReviews())).toEqual([
    expect.objectContaining({ variantId: "second", decision: "iterate", good: ["Works", "Compact"], nextInstructions: ["Try a wider entry"], preferredOverVariantId: "first" })
  ]);
  await page.getByTestId("review-toggle").click();
  await expect(page.locator("body")).not.toHaveClass(/review-mode/);
});

test("generation snapshots and isolated variants validate and activate safely", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setPlan({
      version: 1,
      moduleSizeMm: 3600,
      categories: [{ id: "space", name: "Space", color: "#AABB9C" }],
      cells: { "9,9": { categoryId: "space", zoneId: "working" } },
      underlay: { name: "reference.png", visible: false, transform: { x: 7, y: 8, scale: 1, rotation: 0 } },
      bubbleDiagram: {
        version: 1,
        bubbles: [
          { id: "bedroom", name: "Bedroom", type: "space", size: { value: 25.92, unit: "sqm" }, quantity: 2, position: { x: 10, y: 20 }, metadata: { wing: "west" } },
          { id: "hall", name: "Hall", type: "circulation", size: { value: 12.96, unit: "sqm" }, quantity: 1, position: { x: 40, y: 20 }, metadata: {} },
          { id: "quiet", name: "Quiet", type: "space", size: { value: 12.96, unit: "sqm" }, quantity: 1, position: { x: 90, y: 20 }, metadata: {} }
        ],
        connectors: [
          { id: "adj", fromBubbleId: "bedroom", toBubbleId: "hall", relationType: "adjacent", priority: "required", direction: null, metadata: {} },
          { id: "near", fromBubbleId: "hall", toBubbleId: "quiet", relationType: "near", priority: "preferred", direction: null, metadata: {} },
          { id: "sep", fromBubbleId: "bedroom", toBubbleId: "quiet", relationType: "separate", priority: "required", direction: null, metadata: {} }
        ]
      }
    });
    const snapshotResult = api.createRequirementsSnapshot();
    const snapshot = snapshotResult.requirementsSnapshot;
    api.updateBubble({ id: "bedroom", name: "Changed", position: { x: 999, y: 999 }, metadata: { changed: true } });
    const blockPlan = {
      moduleSizeMm: 3600,
      categories: [{ id: "space", name: "Space", color: "#AABB9C" }],
      cells: {
        "0,0": { categoryId: "space", zoneId: "bed-1" },
        "0,2": { categoryId: "space", zoneId: "bed-2" },
        "1,0": { categoryId: "space", zoneId: "hall-1" },
        "4,0": { categoryId: "space", zoneId: "quiet-1" },
        "8,8": { categoryId: "space", zoneId: "orphan" }
      },
      zoneAssignments: {
        "bed-1": { bubbleId: "bedroom" }, "bed-2": { bubbleId: "bedroom" },
        "hall-1": { bubbleId: "hall" }, "quiet-1": { bubbleId: "quiet" }
      }
    };
    const before = api.getPlan();
    const a = api.createVariant({ requirementsSnapshotId: snapshot.requirementsSnapshotId, variantId: "a", strategy: "edge", blockPlan });
    blockPlan.cells["0,0"].zoneId = "tampered";
    const b = api.createVariant({ requirementsSnapshotId: snapshot.requirementsSnapshotId, variantId: "b", blockPlan: a.variant.blockPlan });
    const invalidZone = api.createVariant({ requirementsSnapshotId: snapshot.requirementsSnapshotId, variantId: "bad", blockPlan: { ...a.variant.blockPlan, zoneAssignments: { missing: { bubbleId: "bedroom" } } } });
    const invalidBubble = api.createVariant({ requirementsSnapshotId: snapshot.requirementsSnapshotId, variantId: "bad2", blockPlan: { ...a.variant.blockPlan, zoneAssignments: { "bed-1": { bubbleId: "missing" } } } });
    const duplicate = api.duplicateVariant({ sourceVariantId: "a", newVariantId: "copy" });
    duplicate.variant.blockPlan.cells["0,0"].zoneId = "leak";
    const deleteParent = api.deleteVariant("a");
    const afterCreate = api.getPlan();
    let activatedEvent = null;
    window.addEventListener("blockplan-variant-activated", (event) => { activatedEvent = event.detail; }, { once: true });
    const activation = api.activateVariant("a");
    return {
      snapshot, storedSnapshot: api.getRequirementsSnapshot(snapshot.requirementsSnapshotId), before, afterCreate,
      a: api.getVariant("a"), b: api.getVariant("b"), storedCopy: api.getVariant("copy"), invalidZone, invalidBubble,
      deleteParent, variantsAfterDelete: api.listVariants(),
      validation: api.validateVariantAgainstDiagram("a"), activation, activatedEvent
    };
  });

  expect(result.snapshot.bubbles[0]).not.toHaveProperty("position");
  expect(result.storedSnapshot.bubbles[0]).toMatchObject({ name: "Bedroom", metadata: { wing: "west" } });
  expect(result.before.cells).toEqual(result.afterCreate.cells);
  expect(result.a.blockPlan.cells["0,0"].zoneId).toBe("bed-1");
  expect(result.b.variantId).toBe("b");
  expect(result.storedCopy.blockPlan.cells["0,0"].zoneId).toBe("bed-1");
  expect(result.storedCopy).toMatchObject({ variantId: "copy", parentVariantId: "a", generationIndex: 3 });
  expect(result.a).toMatchObject({ variantId: "a", generationIndex: 1 });
  expect(result.deleteParent.ok).toBe(false);
  expect(result.deleteParent.error).toContain("children");
  expect(result.variantsAfterDelete.map((variant) => variant.variantId)).toEqual(["a", "b", "copy"]);
  expect(result.invalidZone.ok).toBe(false);
  expect(result.invalidBubble.ok).toBe(false);
  expect(result.activatedEvent).toEqual({ variantId: "a" });
  expect(result.validation.dataErrors).toEqual([]);
  expect(result.validation.hardViolations).toEqual([]);
  expect(result.validation.metrics.quantities.find((item) => item.bubbleId === "bedroom")).toMatchObject({ target: 2, actual: 2 });
  expect(result.validation.metrics.sizes.filter((item) => item.bubbleId === "bedroom")).toEqual([
    expect.objectContaining({ zoneId: "bed-1", targetSqm: 25.92, actualSqm: 12.96, deltaSqm: -12.96, ratio: 0.5 }),
    expect.objectContaining({ zoneId: "bed-2", targetSqm: 25.92, actualSqm: 12.96, deltaSqm: -12.96, ratio: 0.5 })
  ]);
  expect(result.validation.metrics.relationships).toEqual(expect.arrayContaining([
    expect.objectContaining({ connectorId: "adj", minimumGridDistance: 1, adjacentPairCount: 1, fromCoverage: 0.5, toCoverage: 1 }),
    expect.objectContaining({ connectorId: "near", minimumGridDistance: 3 }),
    expect.objectContaining({ connectorId: "sep", minimumGridDistance: 4 })
  ]));
  expect(result.validation.metrics.orphans).toEqual(["orphan"]);
  expect(result.activation.plan.cells).toEqual(result.a.blockPlan.cells);
  expect(result.activation.plan.bubbleDiagram.bubbles.find((bubble) => bubble.id === "bedroom").name).toBe("Changed");
  expect(result.activation.plan.generation.variants).toHaveLength(3);
  expect(result.activation.plan.underlay.name).toBe("reference.png");

  await page.keyboard.press("Control+z");
  const undone = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(undone.cells).toEqual(result.before.cells);
  expect(undone.generation.variants).toHaveLength(3);
  expect(undone.bubbleDiagram.bubbles.find((bubble) => bubble.id === "bedroom").name).toBe("Changed");

  await page.reload();
  const restored = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(restored.generation).toEqual(undone.generation);
});

test("variant validation separates hard and soft relationship failures", async ({ page }) => {
  await page.goto(appUrl);
  const validation = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [
      { id: "a", name: "A", size: { value: 1, unit: "sqm" }, quantity: 2, position: { x: 0, y: 0 } },
      { id: "b", name: "B", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } }
    ], connectors: [
      { id: "required-adjacent", fromBubbleId: "a", toBubbleId: "b", relationType: "adjacent", priority: "required" },
      { id: "preferred-separate", fromBubbleId: "a", toBubbleId: "b", relationType: "separate", priority: "preferred" }
    ] });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "violations", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: {
      moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }],
      cells: { "0,0": { categoryId: "x", zoneId: "a1" }, "1,0": { categoryId: "x", zoneId: "b1" } },
      zoneAssignments: { a1: { bubbleId: "a" }, b1: { bubbleId: "b" } }
    } });
    return api.validateVariantAgainstDiagram("violations");
  });
  expect(validation.hardViolations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "quantity_mismatch", bubbleId: "a" })]));
  expect(validation.softIssues).toEqual([expect.objectContaining({ code: "separate_violation" })]);
});

test("nullable Bubble constraints survive snapshots and do not create validation violations", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [
      { id: "open", name: "Open", size: null, quantity: null, position: { x: 0, y: 0 } }
    ], connectors: [] });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "unconstrained", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: {
      moduleSizeMm: 1000,
      categories: [{ id: "x", name: "X", color: "#111111" }],
      cells: { "0,0": { categoryId: "x", zoneId: "open-1" } },
      zoneAssignments: { "open-1": { bubbleId: "open" } }
    } });
    return { snapshot, validation: api.validateVariantAgainstDiagram("unconstrained") };
  });

  expect(result.snapshot.bubbles[0]).toMatchObject({ size: null, quantity: null });
  expect(result.validation.dataErrors).toEqual([]);
  expect(result.validation.hardViolations).toEqual([]);
  expect(result.validation.metrics.quantities[0]).toMatchObject({ target: null, actual: 1 });
  expect(result.validation.metrics.sizes[0]).toMatchObject({ targetSqm: null, actualSqm: 1, deltaSqm: null, ratio: null });
});

test("relationships without an assigned group are not evaluable and do not duplicate violations", async ({ page }) => {
  await page.goto(appUrl);
  const validation = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [
      { id: "a", name: "A", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } },
      { id: "missing", name: "Missing", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } }
    ], connectors: [
      { id: "adj", fromBubbleId: "a", toBubbleId: "missing", relationType: "adjacent", priority: "required" },
      { id: "sep", fromBubbleId: "a", toBubbleId: "missing", relationType: "separate", priority: "required" }
    ] });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    api.createVariant({ variantId: "not-evaluable", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: {
      moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }],
      cells: { "0,0": { categoryId: "x", zoneId: "a1" } }, zoneAssignments: { a1: { bubbleId: "a" } }
    } });
    return api.validateVariantAgainstDiagram("not-evaluable");
  });
  expect(validation.hardViolations).toEqual([expect.objectContaining({ code: "quantity_mismatch", bubbleId: "missing" })]);
  expect(validation.softIssues).toEqual([]);
  expect(validation.metrics.relationships).toEqual([
    expect.objectContaining({ connectorId: "adj", evaluationStatus: "not-evaluable", notEvaluableReason: "to-bubble-has-no-assigned-zones" }),
    expect.objectContaining({ connectorId: "sep", evaluationStatus: "not-evaluable", notEvaluableReason: "to-bubble-has-no-assigned-zones" })
  ]);
});

test("setPlan rejects malformed persisted generation atomically", async ({ page }) => {
  await page.goto(appUrl);
  const results = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.paintRect({ x: 7, y: 7, width: 1, height: 1, categoryId: "unassigned", zoneId: "working" });
    const before = api.getPlan();
    const snapshot = {
      requirementsSnapshotId: "requirements-1", version: 1, createdAt: "2026-01-01T00:00:00.000Z", metadata: {},
      bubbles: [{ id: "a", name: "A", type: "space", size: { value: 1, unit: "sqm" }, quantity: 1, metadata: {} }], connectors: []
    };
    const variant = {
      variantId: "variant-1", requirementsSnapshotId: "requirements-1", parentVariantId: null, generationIndex: 1,
      strategy: "", rationale: "", generator: {}, createdAt: "2026-01-01T00:00:00.000Z",
      blockPlan: { moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], cells: { "0,0": { categoryId: "x", zoneId: "z" } }, zoneAssignments: { z: { bubbleId: "a" } } }
    };
    const attempt = (generation) => api.setPlan({ ...before, generation });
    const cases = [
      { version: 1, requirementsSnapshots: [snapshot, snapshot], variants: [] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [variant, variant] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, requirementsSnapshotId: "missing" }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, parentVariantId: "missing" }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, cells: { "0,0": { categoryId: "missing", zoneId: "z" } } } }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, categories: [{ id: "x", name: "", color: "#111111" }] } }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, categories: [{ id: "x", name: "X" }] } }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, categories: [{ id: "x", name: "X", color: "red" }] } }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, categories: [{ id: "x", name: "X", color: "#111111" }, { id: "y", name: "Y", color: "#222222" }], cells: { "0,0": { categoryId: "x", zoneId: "z" }, "1,0": { categoryId: "y", zoneId: "z" } } } }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, zoneAssignments: { missing: { bubbleId: "a" } } } }] },
      { version: 1, requirementsSnapshots: [snapshot], variants: [{ ...variant, blockPlan: { ...variant.blockPlan, zoneAssignments: { z: { bubbleId: "missing" } } } }] }
    ];
    const rejected = cases.map(attempt);
    return { rejected, before, after: api.getPlan() };
  });
  expect(results.rejected).toHaveLength(11);
  results.rejected.forEach((result) => expect(result.ok).toBe(false));
  expect(results.after).toEqual(results.before);
});

test("createVariant rejects malformed categories and mixed-category zones atomically", async ({ page }) => {
  await page.goto(appUrl);
  const results = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.paintRect({ x: 3, y: 3, width: 1, height: 1, categoryId: "unassigned", zoneId: "working" });
    api.setBubbleDiagram({ version: 1, bubbles: [
      { id: "a", name: "A", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 } }
    ], connectors: [] });
    const snapshotId = api.createRequirementsSnapshot().requirementsSnapshot.requirementsSnapshotId;
    const before = api.getPlan();
    const base = {
      moduleSizeMm: 1000,
      categories: [{ id: "x", name: "X", color: "#111111" }],
      cells: { "0,0": { categoryId: "x", zoneId: "z" } },
      zoneAssignments: { z: { bubbleId: "a" } }
    };
    const create = (variantId, blockPlan) => api.createVariant({ variantId, requirementsSnapshotId: snapshotId, blockPlan });
    const rejected = [
      create("empty-name", { ...base, categories: [{ id: "x", name: "", color: "#111111" }] }),
      create("missing-color", { ...base, categories: [{ id: "x", name: "X" }] }),
      create("invalid-color", { ...base, categories: [{ id: "x", name: "X", color: "rgb(1, 2, 3)" }] }),
      create("mixed-zone", {
        ...base,
        categories: [...base.categories, { id: "y", name: "Y", color: "#222222" }],
        cells: { "0,0": { categoryId: "x", zoneId: "z" }, "1,0": { categoryId: "y", zoneId: "z" } }
      })
    ];
    return { rejected, before, after: api.getPlan(), variants: api.listVariants() };
  });
  results.rejected.forEach((result) => expect(result.ok).toBe(false));
  expect(results.variants).toEqual([]);
  expect(results.after).toEqual(results.before);
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
  expect(loaded.bubbleDiagram.bubbles[0]).toMatchObject({ type: "space", quantity: null, position: { x: 0, y: 0 }, metadata: {} });
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

test("whole-diagram API canonicalizes nullable fields and connector defaults", async ({ page }) => {
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
    const unspecifiedBubble = api.addBubble({ id: "no-size", name: "No size" });
    const defaultConnector = api.connectBubbles({ id: "default-connector", fromBubbleId: "a", toBubbleId: "b" });
    return { accepted, beforeFailures, missingBubbleId, missingBubbleName, unspecifiedBubble, defaultConnector, afterChanges: api.getBubbleDiagram() };
  });

  expect(result.accepted.ok).toBe(true);
  expect(result.accepted.bubbleDiagram.bubbles).toEqual([
    { id: "a", name: "A", type: "space", size: { value: 10, unit: "sqm" }, quantity: null, position: { x: 0, y: 0 }, metadata: {} },
    { id: "b", name: "B", type: "space", size: { value: 12, unit: "sqm" }, quantity: null, position: { x: 0, y: 0 }, metadata: {} }
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
  expect(result.unspecifiedBubble.bubble).toMatchObject({ size: null, quantity: null });
  expect(result.defaultConnector.connector).toMatchObject({ relationType: "adjacent", priority: "preferred" });
});

test("nested Bubble and Connector metadata is defensively copied across API boundaries", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const bubbleMetadata = { requirements: { tags: ["quiet", { access: "private" }] } };
    const connectorMetadata = { rationale: { sources: ["brief", { author: "client" }] } };
    const set = api.setBubbleDiagram({
      version: 1,
      bubbles: [
        { id: "a", name: "A", size: { value: 10, unit: "sqm" }, metadata: bubbleMetadata },
        { id: "b", name: "B", size: { value: 12, unit: "sqm" } }
      ],
      connectors: [{
        id: "a-b",
        fromBubbleId: "a",
        toBubbleId: "b",
        relationType: "near",
        priority: "preferred",
        metadata: connectorMetadata
      }]
    });

    bubbleMetadata.requirements.tags[1].access = "public";
    connectorMetadata.rationale.sources[1].author = "mutated caller";
    const afterCallerMutation = api.getBubbleDiagram();

    const returnedDiagram = api.getBubbleDiagram();
    returnedDiagram.bubbles[0].metadata.requirements.tags[1].access = "mutated return";
    returnedDiagram.connectors[0].metadata.rationale.sources[1].author = "mutated return";
    const afterDiagramMutation = api.getBubbleDiagram();

    const returnedPlan = api.getPlan();
    returnedPlan.bubbleDiagram.bubbles[0].metadata.requirements.tags[0] = "mutated plan";
    returnedPlan.bubbleDiagram.connectors[0].metadata.rationale.sources[0] = "mutated plan";
    const afterPlanMutation = api.getPlan().bubbleDiagram;

    return { set, afterCallerMutation, afterDiagramMutation, afterPlanMutation };
  });

  expect(result.set.ok).toBe(true);
  [result.afterCallerMutation, result.afterDiagramMutation, result.afterPlanMutation].forEach((diagram) => {
    expect(diagram.bubbles[0].metadata).toEqual({ requirements: { tags: ["quiet", { access: "private" }] } });
    expect(diagram.connectors[0].metadata).toEqual({ rationale: { sources: ["brief", { author: "client" }] } });
  });
});
