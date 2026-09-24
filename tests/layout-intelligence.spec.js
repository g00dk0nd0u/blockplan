const { test, expect } = require("@playwright/test");
const path = require("path");
const { dataCenter, office } = require("./fixtures/layout-benchmarks");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;
const categories = [{ id: "space", name: "Space", color: "#445566" }];

async function installBenchmark(page, fixture, cells, assignments) {
  return page.evaluate(({ fixture, cells, assignments, categories }) => {
    const api = window.BlockPlanAPI;
    api.setModuleSize(1000);
    const working = api.getPlan();
    working.categories = categories;
    api.setPlan(working);
    api.setBubbleDiagram({ version: 1, bubbles: fixture.bubbles, connectors: fixture.connectors });
    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", { rulePack: fixture.rulePack });
    const snapshotId = prepared.request.requirementsSnapshotId;
    const created = api.createVariant({ variantId: `${fixture.rulePack.id}-variant`, requirementsSnapshotId: snapshotId, blockPlan: { moduleSizeMm: 1000, categories, cells, zoneAssignments: assignments } });
    return { prepared, snapshotId, created, problem: api.getLayoutProblem(snapshotId), evaluation: api.evaluateVariantLayout(created.variant.variantId) };
  }, { fixture, cells, assignments, categories });
}

test("Rule Pack v1 is strict, canonical, and rejects unsupported input", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const valid = { version: 1, id: "generic", rules: [
      { id: "area", kind: "area-tolerance", selector: { types: ["room"] }, severity: "required", parameters: { maxRelativeDeviation: 0.2 } },
      { id: "ratio", kind: "aspect-ratio", selector: { bubbleIds: ["b"] }, severity: "preferred", parameters: { minimum: 1, maximum: 2 } },
      { id: "fill", kind: "compactness", selector: { bubbleIds: ["b"] }, severity: "preferred", parameters: { minimumFillRatio: 0.75 } },
      { id: "near", kind: "near-distance", selector: { types: ["room"] }, severity: "preferred", parameters: { maximumGridGap: 2 } },
      { id: "repeat", kind: "repeatability", selector: { types: ["room"] }, severity: "preferred", parameters: {} }
    ] };
    const attempt = (pack) => { try { return window.LayoutIntelligence.requireValidRulePack(pack); } catch (error) { return error.message; } };
    const withParameter = (rule, parameters) => ({ version: 1, id: "x", rules: [{ ...rule, parameters }] });
    return {
      valid: attempt(valid),
      badKind: attempt({ version: 1, id: "x", rules: [{ ...valid.rules[0], kind: "egress" }] }),
      badSelector: attempt({ version: 1, id: "x", rules: [{ ...valid.rules[0], selector: { names: ["Room"] } }] }),
      badParameters: attempt(withParameter(valid.rules[0], { maxRelativeDeviation: -1 })),
      unsupportedRoot: attempt({ version: 1, id: "x", rules: [], buildingType: "data-center" }),
      numericString: attempt(withParameter(valid.rules[0], { maxRelativeDeviation: "0.2" })),
      numericNull: attempt(withParameter(valid.rules[0], { maxRelativeDeviation: null })),
      numericBoolean: attempt(withParameter(valid.rules[0], { maxRelativeDeviation: true })),
      fillString: attempt(withParameter(valid.rules[2], { minimumFillRatio: "0.8" })),
      ratioBelowOne: attempt(withParameter(valid.rules[1], { maximum: 0.5 })),
      fractionalGap: attempt(withParameter(valid.rules[3], { maximumGridGap: 1.5 })),
      gapString: attempt(withParameter(valid.rules[3], { maximumGridGap: "2" }))
    };
  });
  expect(result.valid.rules).toHaveLength(5);
  expect(result.valid.rules[4].parameters.requireIdentical).toBe(true);
  expect(result.badKind).toContain("unsupported kind");
  expect(result.badSelector).toContain("selector");
  expect(result.badParameters).toContain("invalid");
  expect(result.unsupportedRoot).toContain("unsupported field");
  [result.numericString, result.numericNull, result.numericBoolean, result.fillString, result.ratioBelowOne, result.fractionalGap, result.gapString].forEach((error) => expect(error).toContain("invalid"));
});

test("LayoutProblem rejects malformed frozen generation contexts without mutating Snapshots", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [{ id: "room", name: "Room", type: "work" }], connectors: [] });
    const contexts = [
      { version: 1, moduleSizeMm: "1000", categories: [{ id: "x", name: "X", color: "#123456" }] },
      { version: 1, moduleSizeMm: 1000, categories: [] },
      { version: 1, moduleSizeMm: 1000, categories: [{ id: "x", name: "", color: "not-a-color" }] },
      { version: 1, moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#123456" }, { id: "x", name: "Duplicate", color: "#654321" }] }
    ];
    return contexts.map((generationContext) => {
      const snapshot = api.createRequirementsSnapshot({ metadata: { generationContext } }).requirementsSnapshot;
      const before = api.getRequirementsSnapshot(snapshot.requirementsSnapshotId);
      const problem = api.getLayoutProblem(snapshot.requirementsSnapshotId);
      const after = api.getRequirementsSnapshot(snapshot.requirementsSnapshotId);
      return { problem, before, after };
    });
  });
  result.forEach(({ problem, before, after }) => {
    expect(problem.ok).toBe(false);
    expect(after).toEqual(before);
  });
  expect(result[0].problem.error).toContain("moduleSizeMm");
  expect(result[1].problem.error).toContain("non-empty array");
  expect(result[2].problem.error).toContain("name");
  expect(result[3].problem.error).toContain("Duplicate");
});

test("LayoutProblem is frozen, sanitized, deterministic, and includes only approved relevant Memory", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setModuleSize(1000);
    api.setBubbleDiagram({ version: 1, bubbles: [{ id: "room", name: "Room", type: "work", size: { value: 2, unit: "sqm" }, quantity: 1, position: { x: 99, y: 88 }, metadata: { tag: "brief" } }], connectors: [] });
    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", { rulePack: { version: 1, id: "frozen", rules: [] } });
    const id = prepared.request.requirementsSnapshotId;
    const variant = api.createVariant({ requirementsSnapshotId: id, blockPlan: { moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#123456" }], cells: { "0,0": { categoryId: "x", zoneId: "z" } }, zoneAssignments: { z: { bubbleId: "room" } } } }).variant;
    const review = api.createReview({ variantId: variant.variantId, decision: "iterate" }).review;
    ["approved", "candidate", "rejected"].forEach((status) => {
      api.proposeMemoryFromReviews({ memoryId: status, scope: "project", type: "soft-preference", statement: status, applicableConditions: { bubbleTypes: ["work"] }, evidenceReviewIds: [review.reviewId] });
      if (status === "approved") api.approveMemory(status);
      if (status === "rejected") api.rejectMemory(status);
    });
    const before = api.getLayoutProblem(id);
    api.setModuleSize(2000);
    const plan = api.getPlan(); plan.categories = [{ id: "changed", name: "Changed", color: "#654321" }]; api.setPlan(plan);
    const after = api.getLayoutProblem(id);
    const fetched = window.BlockPlanAgent.callTool("get_generation_request", { requirementsSnapshotId: id });
    return { before, after, snapshot: api.getRequirementsSnapshot(id), request: fetched.request };
  });
  expect(result.after).toEqual(result.before);
  expect(result.before).toMatchObject({ version: 1, moduleSizeMm: 1000, rulePack: { id: "frozen" }, spaces: [{ bubbleId: "room", targetSize: { value: 2, unit: "sqm" } }] });
  expect(result.before.relevantMemory.map((item) => item.memoryId)).toEqual(["approved"]);
  expect(JSON.stringify(result.before)).not.toMatch(/position|underlay|screenshot|credential|cells/);
  expect(result.request.layoutProblem).toEqual(result.before);
  expect(result.snapshot.metadata.generationContext.rulePack.id).toBe("frozen");
});

test("geometry, existing relationship metrics, rule findings, and immutability are derived", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setBubbleDiagram({ version: 1, bubbles: [
      { id: "a", name: "A", type: "room", size: { value: 6, unit: "sqm" }, quantity: 2 },
      { id: "b", name: "B", type: "support", size: { value: 1, unit: "sqm" }, quantity: 1 }
    ], connectors: [
      { id: "adj", fromBubbleId: "a", toBubbleId: "b", relationType: "adjacent", priority: "required" },
      { id: "sep", fromBubbleId: "a", toBubbleId: "b", relationType: "separate", priority: "preferred" },
      { id: "near", fromBubbleId: "a", toBubbleId: "b", relationType: "near", priority: "preferred" }
    ] });
    const rulePack = { version: 1, id: "metrics", rules: [
      { id: "area", kind: "area-tolerance", selector: { bubbleIds: ["a"] }, severity: "required", parameters: { maxRelativeDeviation: 0.2 } },
      { id: "shape", kind: "aspect-ratio", selector: { bubbleIds: ["a"] }, severity: "preferred", parameters: { maximum: 2 } },
      { id: "fill", kind: "compactness", selector: { bubbleIds: ["a"] }, severity: "preferred", parameters: { minimumFillRatio: 0.8 } },
      { id: "near-rule", kind: "near-distance", selector: { bubbleIds: ["a", "b"] }, severity: "preferred", parameters: { maximumGridGap: 0 } },
      { id: "repeat", kind: "repeatability", selector: { types: ["room"] }, severity: "preferred", parameters: { requireIdentical: true } }
    ] };
    const snapshot = api.createRequirementsSnapshot({ metadata: { generationContext: { version: 1, moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], rulePack } } }).requirementsSnapshot;
    const cells = {};
    ["0,0", "1,0", "2,0", "0,1", "2,1"].forEach((key) => { cells[key] = { categoryId: "x", zoneId: "a1" }; });
    ["10,10", "11,10", "12,10", "10,11", "11,11"].forEach((key) => { cells[key] = { categoryId: "x", zoneId: "a2" }; });
    cells["3,0"] = { categoryId: "x", zoneId: "b1" };
    const variant = api.createVariant({ variantId: "metrics", requirementsSnapshotId: snapshot.requirementsSnapshotId, blockPlan: { moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], cells, zoneAssignments: { a1: { bubbleId: "a" }, a2: { bubbleId: "a" }, b1: { bubbleId: "b" } } } }).variant;
    const before = { variant: api.getVariant("metrics"), snapshot: api.getRequirementsSnapshot(snapshot.requirementsSnapshotId), plan: api.getPlan() };
    const evaluation = api.evaluateVariantLayout("metrics");
    const after = { variant: api.getVariant("metrics"), snapshot: api.getRequirementsSnapshot(snapshot.requirementsSnapshotId), plan: api.getPlan() };
    return { evaluation, before, after, directTranslated: window.LayoutIntelligence.shapeSignature(["0,0", "1,0"]), translated: window.LayoutIntelligence.shapeSignature(["7,9", "8,9"]) };
  });
  expect(result.after).toEqual(result.before);
  expect(result.directTranslated).toBe(result.translated);
  const a1 = result.evaluation.metrics.zones.find((zone) => zone.zoneId === "a1");
  expect(a1).toMatchObject({ cellCount: 5, areaSqm: 5, widthCells: 3, heightCells: 2, aspectRatio: 1.5, boundingBoxFillRatio: 5 / 6, perimeterEdgeCount: 12 });
  expect(result.evaluation.metrics.bubbles[0].relativeAreaDeviations[0]).toBeCloseTo(1 / 6);
  expect(result.evaluation.metrics.relationships).toEqual(result.evaluation.metrics.validation.relationships);
  expect(result.evaluation.metrics.relationships.find((item) => item.connectorId === "adj")).toMatchObject({ minimumGridDistance: 1, minimumGridGap: 0, evaluationStatus: "evaluated" });
  expect(result.evaluation.hardViolations.some((item) => item.code === "separate_violation")).toBe(false);
  expect(result.evaluation.softIssues.some((item) => item.code === "separate_violation")).toBe(true);
  expect(result.evaluation.criticFindings.map((item) => item.code)).toContain("repeatability_shapes_differ");
  ["overallScore", "designScore", "winner", "rank", "bestVariant"].forEach((key) => expect(result.evaluation).not.toHaveProperty(key));
  expect(result.before.variant).not.toHaveProperty("evaluation");
});

test("Data Center benchmark uses generic rules and yields deterministic repeatability", async ({ page }) => {
  await page.goto(appUrl);
  const cells = {}, assignments = { hall1: { bubbleId: "hall" }, hall2: { bubbleId: "hall" }, electrical1: { bubbleId: "electrical" }, mechanical1: { bubbleId: "mechanical" }, mmr1: { bubbleId: "mmr" } };
  [["hall1", 0, 0], ["hall2", 0, 3]].forEach(([zone, x, y]) => [0, 1].forEach((dx) => [0, 1].forEach((dy) => { cells[`${x + dx},${y + dy}`] = { categoryId: "space", zoneId: zone }; })));
  cells["2,0"] = { categoryId: "space", zoneId: "electrical1" }; cells["2,1"] = { categoryId: "space", zoneId: "electrical1" };
  cells["3,3"] = { categoryId: "space", zoneId: "mechanical1" }; cells["3,4"] = { categoryId: "space", zoneId: "mechanical1" };
  cells["5,0"] = { categoryId: "space", zoneId: "mmr1" };
  const result = await installBenchmark(page, dataCenter, cells, assignments);
  expect(result.created.ok).toBe(true);
  expect(result.problem.moduleSizeMm).toBe(1000);
  expect(result.problem.categories.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "unassigned", name: "Unassigned" },
    ...dataCenter.bubbles.map((bubble) => ({ id: `bubble::${bubble.id}`, name: bubble.name }))
  ]);
  expect(result.evaluation.qualityDimensions.repeatability.find((item) => item.bubbleId === "hall")).toMatchObject({ zoneCount: 2, distinctShapeCount: 1, identicalShapes: true });
  expect(result.evaluation.hardViolations).toEqual([]);
  expect(result.evaluation).not.toHaveProperty("overallScore");
});

test("Office benchmark runs through the same domain-neutral evaluator", async ({ page }) => {
  await page.goto(appUrl);
  const cells = {}, assignments = { work1: { bubbleId: "work" }, meeting1: { bubbleId: "meeting" }, reception1: { bubbleId: "reception" }, support1: { bubbleId: "support" } };
  ["0,0", "1,0", "0,1", "1,1"].forEach((key) => { cells[key] = { categoryId: "space", zoneId: "work1" }; });
  ["2,0", "2,1"].forEach((key) => { cells[key] = { categoryId: "space", zoneId: "meeting1" }; });
  cells["3,0"] = { categoryId: "space", zoneId: "reception1" }; cells["3,1"] = { categoryId: "space", zoneId: "support1" };
  const result = await installBenchmark(page, office, cells, assignments);
  expect(result.created.ok).toBe(true);
  expect(result.problem.moduleSizeMm).toBe(1000);
  expect(result.problem.categories.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "unassigned", name: "Unassigned" },
    ...office.bubbles.map((bubble) => ({ id: `bubble::${bubble.id}`, name: bubble.name }))
  ]);
  expect(result.evaluation.hardViolations).toEqual([]);
  expect(result.problem.spaces.map((space) => space.type)).toEqual(["work", "collaboration", "arrival", "support"]);
  expect(result.evaluation.criticFindings).toEqual([]);
});

test("Agent tools expose LayoutProblem and derived evaluation", async ({ page }) => {
  await page.goto(`${appUrl}?agent=1`);
  const result = await installBenchmark(page, office, { "0,0": { categoryId: "space", zoneId: "work1" }, "1,0": { categoryId: "space", zoneId: "meeting1" }, "2,0": { categoryId: "space", zoneId: "reception1" }, "3,0": { categoryId: "space", zoneId: "support1" } }, { work1: { bubbleId: "work" }, meeting1: { bubbleId: "meeting" }, reception1: { bubbleId: "reception" }, support1: { bubbleId: "support" } });
  const tools = await page.evaluate(({ snapshotId, variantId }) => ({ names: window.BlockPlanAgent.listTools().tools.map((tool) => tool.name), problem: window.BlockPlanAgent.callTool("get_layout_problem", { requirementsSnapshotId: snapshotId }), evaluation: window.BlockPlanAgent.callTool("evaluate_layout_variant", { variantId }) }), { snapshotId: result.snapshotId, variantId: result.created.variant.variantId });
  expect(tools.names).toEqual(expect.arrayContaining(["get_layout_problem", "evaluate_layout_variant"]));
  expect(tools.problem).toMatchObject({ ok: true, layoutProblem: { requirementsSnapshotId: result.snapshotId } });
  expect(tools.evaluation).toMatchObject({ ok: true, variantId: result.created.variant.variantId, evaluation: { version: 1 } });
});
