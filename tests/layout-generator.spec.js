const { test, expect } = require("@playwright/test");
const path = require("path");
const { dataCenter, office } = require("./fixtures/layout-benchmarks");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;
const categories = [{ id: "space", name: "Space", color: "#445566" }];

async function prepare(page, fixture, frame) {
  return page.evaluate(({ fixture, frame, categories }) => {
    const api = window.BlockPlanAPI;
    api.setModuleSize(1000);
    const plan = api.getPlan(); plan.categories = categories; api.setPlan(plan);
    api.setBubbleDiagram({ version: 1, bubbles: fixture.bubbles, connectors: fixture.connectors });
    return window.BlockPlanAgent.callTool("prepare_generation_request", { rulePack: fixture.rulePack, generationFrame: frame });
  }, { fixture, frame, categories });
}

test("GenerationFrame validation is strict and frozen in LayoutProblem", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const valid = { version: 1, bounds: { x: 0, y: 0, width: 20, height: 12 } };
    const attempt = (value) => { try { return window.LayoutGenerator.normalizeGenerationFrame(value); } catch (error) { return error.message; } };
    return { valid: attempt(valid), string: attempt({ version: 1, bounds: { x: "0", y: 0, width: 2, height: 2 } }), unknown: attempt({ ...valid, cells: {} }), boundsUnknown: attempt({ version: 1, bounds: { ...valid.bounds, maxX: 2 } }), zero: attempt({ version: 1, bounds: { x: 0, y: 0, width: 0, height: 2 } }) };
  });
  expect(result.valid).toEqual({ version: 1, bounds: { x: 0, y: 0, width: 20, height: 12 } });
  [result.string, result.unknown, result.boundsUnknown, result.zero].forEach((error) => expect(typeof error).toBe("string"));

  const prepared = await prepare(page, office, { version: 1, bounds: { x: 0, y: 0, width: 12, height: 8 } });
  const stable = await page.evaluate((id) => { const api = window.BlockPlanAPI; const before = api.getLayoutProblem(id); api.paintRect({ x: 99, y: 99, width: 2, height: 2, categoryId: "space" }); return { before, after: api.getLayoutProblem(id), snapshot: api.getRequirementsSnapshot(id) }; }, prepared.request.requirementsSnapshotId);
  expect(stable.after).toEqual(stable.before);
  expect(stable.before.generationFrame.bounds).toEqual({ x: 0, y: 0, width: 12, height: 8 });
  expect(JSON.stringify(stable.before)).not.toContain("99,99");
  expect(stable.snapshot.metadata.generationContext.generationFrame).toEqual(stable.before.generationFrame);
});

test("space expansion, shape enumeration, and topology are deterministic and domain-neutral", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const problem = { version: 1, requirementsSnapshotId: "r", moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], spaces: [{ bubbleId: "a", type: "generic", targetSize: { value: 10, unit: "sqm" }, quantity: 2 }, { bubbleId: "b", type: "other", targetSize: { value: 2, unit: "m2" }, quantity: null }], relationships: [{ connectorId: "c", fromBubbleId: "a", toBubbleId: "b", relationType: "adjacent", priority: "required" }], rulePack: { version: 1, id: "rules", rules: [{ id: "ratio", kind: "aspect-ratio", selector: { bubbleIds: ["a"] }, severity: "required", parameters: { maximum: 2.5 } }, { id: "area", kind: "area-tolerance", selector: { bubbleIds: ["a"] }, severity: "required", parameters: { maxRelativeDeviation: 0.2 } }] } };
    const first = window.LayoutGenerator.expandSpaceInstances(problem);
    const second = window.LayoutGenerator.expandSpaceInstances(problem);
    return { first, second, shapes: window.LayoutGenerator.enumerateShapeCandidates(first.instances[0], problem), strategies: window.LayoutGenerator.buildTopologyStrategies(problem, first.instances) };
  });
  expect(result.first).toEqual(result.second);
  expect(result.first.instances.map((item) => item.instanceId)).toEqual(["a::1", "a::2", "b::1"]);
  expect(result.first.instances[0]).toMatchObject({ targetAreaSqm: 10, targetCellCount: 10, quantityIndex: 1, quantityAssumedSingle: false });
  expect(result.first.instances[2].quantityAssumedSingle).toBe(true);
  expect(result.shapes.length).toBeGreaterThan(0);
  expect(result.shapes.every((shape) => shape.aspectRatio <= 2.5 && shape.relativeAreaDeviation <= 0.2)).toBe(true);
  expect(result.strategies.map((item) => item.family)).toEqual(["relationship-first", "area-first", "repeatability-first"]);
  expect(JSON.stringify(result.strategies)).not.toMatch(/office|data hall|mmr/i);
});

test("missing size fails explicitly and inferred frame is deterministic", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const problem = { version: 1, requirementsSnapshotId: "r", moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], spaces: [{ bubbleId: "x", type: "room", targetSize: null, quantity: 1 }], relationships: [], relevantMemory: [], rulePack: null };
    const snapshot = { requirementsSnapshotId: "r", bubbles: [{ id: "x", type: "room", size: null, quantity: 1 }], connectors: [] };
    return [window.LayoutGenerator.generateCandidates(problem, snapshot), window.LayoutGenerator.generateCandidates(problem, snapshot)];
  });
  expect(result[0]).toEqual(result[1]);
  expect(result[0].candidates).toEqual([]);
  expect(result[0].diagnostics).toContainEqual(expect.objectContaining({ code: "missing_evaluable_size", bubbleId: "x" }));
  expect(result[0].metadata.frameSource).toBe("inferred");
});

test("rectangle adjacency requires a positive-length shared edge", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const touches = window.LayoutGenerator.rectTouches, base = { x: 0, y: 0, width: 2, height: 2 };
    return {
      horizontal: touches(base, { x: 2, y: 0, width: 1, height: 2 }),
      vertical: touches(base, { x: 0, y: 2, width: 2, height: 1 }),
      corner: touches(base, { x: 2, y: 2, width: 1, height: 1 }),
      overlap: touches(base, { x: 1, y: 1, width: 2, height: 2 }),
      gap: touches(base, { x: 3, y: 0, width: 1, height: 2 })
    };
  });
  expect(result).toEqual({ horizontal: true, vertical: true, corner: false, overlap: false, gap: false });
});

test("bounded repair translates a rectangle and re-evaluates the repaired geometry", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const problem = { version: 1, requirementsSnapshotId: "repair", moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], generationFrame: { version: 1, bounds: { x: 0, y: 0, width: 4, height: 2 } }, spaces: [{ bubbleId: "a", type: "room", targetSize: { value: 1, unit: "sqm" }, quantity: 1 }, { bubbleId: "b", type: "room", targetSize: { value: 1, unit: "sqm" }, quantity: 1 }], relationships: [{ connectorId: "adj", fromBubbleId: "a", toBubbleId: "b", relationType: "adjacent", priority: "required" }], rulePack: null };
    const snapshot = { requirementsSnapshotId: "repair", bubbles: [{ id: "a", type: "room", size: { value: 1, unit: "sqm" }, quantity: 1 }, { id: "b", type: "room", size: { value: 1, unit: "sqm" }, quantity: 1 }], connectors: [{ id: "adj", fromBubbleId: "a", toBubbleId: "b", relationType: "adjacent", priority: "required" }] };
    const candidate = { strategy: "repair", rationale: "repair", blockPlan: { moduleSizeMm: 1000, categories: problem.categories, cells: { "0,0": { categoryId: "x", zoneId: "a" }, "2,0": { categoryId: "x", zoneId: "b" } }, zoneAssignments: { a: { bubbleId: "a" }, b: { bubbleId: "b" } } } };
    const before = window.LayoutIntelligence.evaluateVariant({ variantId: "before", requirementsSnapshotId: "repair", blockPlan: candidate.blockPlan }, snapshot, { layoutProblem: problem });
    const repaired = window.LayoutGenerator.repairCandidate(candidate, { frame: problem.generationFrame, problem, requirementsSnapshot: snapshot, maxRepairIterations: 2 });
    return { before, repaired };
  });
  expect(result.before.hardViolations).toHaveLength(1);
  expect(result.repaired.evaluation.hardViolations).toEqual([]);
  expect(result.repaired.candidate.blockPlan.cells).toHaveProperty("1,0");
  expect(result.repaired.candidate.blockPlan.cells).not.toHaveProperty("0,0");
});

for (const [name, fixture, frame] of [["Data Center", dataCenter, { version: 1, bounds: { x: 0, y: 0, width: 16, height: 12 } }], ["Office", office, { version: 1, bounds: { x: 0, y: 0, width: 12, height: 10 } }]]) {
  test(`${name} benchmark generates feasible isolated candidates`, async ({ page }) => {
    await page.goto(appUrl);
    const prepared = await prepare(page, fixture, frame);
    const result = await page.evaluate((id) => {
      const api = window.BlockPlanAPI, before = api.getPlan();
      const generated = api.generateLayoutCandidates(id, { requestedVariantCount: 3, maxStates: 50000 });
      const after = api.getPlan();
      const evaluations = generated.candidates.map((candidate) => window.LayoutIntelligence.evaluateVariant({ variantId: "derived", requirementsSnapshotId: id, blockPlan: candidate.blockPlan }, api.getRequirementsSnapshot(id), { layoutProblem: api.getLayoutProblem(id) }));
      return { generated, before, after, evaluations };
    }, prepared.request.requirementsSnapshotId);
    expect(result.after.cells).toEqual(result.before.cells);
    expect(result.after.generation.variants).toEqual(result.before.generation.variants);
    expect(result.generated.candidates.length).toBeGreaterThan(0);
    expect(result.generated.metadata.frameSource).toBe("explicit");
    result.evaluations.forEach((evaluation) => { expect(evaluation.dataErrors).toEqual([]); expect(evaluation.hardViolations).toEqual([]); });
    result.generated.candidates.forEach((candidate) => {
      expect(candidate).not.toHaveProperty("overallScore"); expect(candidate).not.toHaveProperty("winner"); expect(candidate).not.toHaveProperty("rank");
      const keys = Object.keys(candidate.blockPlan.cells); expect(new Set(keys).size).toBe(keys.length);
      Object.values(candidate.blockPlan.zoneAssignments).forEach((assignment) => expect(assignment.bubbleId).toBeTruthy());
    });
  });
}

test("diversity ignores translation and zone ids, and search budget terminates", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const candidate = (offset, zoneId) => ({ strategy: "x", rationale: "x", blockPlan: { moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], cells: { [`${offset},${offset}`]: { categoryId: "x", zoneId }, [`${offset + 1},${offset}`]: { categoryId: "x", zoneId } }, zoneAssignments: { [zoneId]: { bubbleId: "room" } } }, dimensions: { hardViolationCount: 0, preferredIssueCount: 0, areaDeviationSum: 0, repeatabilityMismatchCount: 0 } });
    const selected = window.LayoutGenerator.selectDiverseCandidates([candidate(0, "one"), candidate(10, "renamed")], 3);
    const problem = { version: 1, requirementsSnapshotId: "r", moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], spaces: [{ bubbleId: "a", type: "room", targetSize: { value: 4, unit: "sqm" }, quantity: 2 }], relationships: [], relevantMemory: [], rulePack: null };
    const snapshot = { requirementsSnapshotId: "r", bubbles: [{ id: "a", type: "room", size: { value: 4, unit: "sqm" }, quantity: 2 }], connectors: [] };
    return { selected: selected.length, budget: window.LayoutGenerator.generateCandidates(problem, snapshot, { maxStates: 1 }) };
  });
  expect(result.selected).toBe(1);
  expect(result.budget.diagnostics).toContainEqual(expect.objectContaining({ code: "search_budget_exhausted", maxStates: 1 }));
});

test("selection never restores dominated candidates", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const candidate = (strategy, x, value) => ({ strategy, rationale: strategy, blockPlan: { moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], cells: { [`${x},0`]: { categoryId: "x", zoneId: strategy }, [`${x},1`]: { categoryId: "x", zoneId: strategy } }, zoneAssignments: { [strategy]: { bubbleId: strategy } } }, dimensions: { hardViolationCount: 0, preferredIssueCount: value, areaDeviationSum: value, repeatabilityMismatchCount: value } });
    return window.LayoutGenerator.selectDiverseCandidates([candidate("dominant", 0, 0), candidate("dominated", 3, 1)], 3).map((item) => item.strategy);
  });
  expect(result).toEqual(["dominant"]);
});

test("search budget is deterministic and fairly allocated across strategies", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const problem = { version: 1, requirementsSnapshotId: "budget", moduleSizeMm: 1000, categories: [{ id: "x", name: "X", color: "#111111" }], spaces: [{ bubbleId: "a", type: "room", targetSize: { value: 2, unit: "sqm" }, quantity: 2 }], relationships: [], relevantMemory: [], rulePack: null };
    const snapshot = { requirementsSnapshotId: "budget", bubbles: [{ id: "a", type: "room", size: { value: 2, unit: "sqm" }, quantity: 2 }], connectors: [] };
    const options = { maxStates: 8, requestedVariantCount: 3 };
    return [window.LayoutGenerator.generateCandidates(problem, snapshot, options), window.LayoutGenerator.generateCandidates(problem, snapshot, options)];
  });
  expect(result[0].metadata.exploredStates).toBeLessThanOrEqual(8);
  expect(result[0].metadata.strategySearch.map((item) => item.allocatedStates)).toEqual([3, 3, 2]);
  expect(result[0].metadata.strategySearch.every((item) => item.exploredStates > 0)).toBe(true);
  expect(result[0].metadata.strategySearch).toEqual(result[1].metadata.strategySearch);
});

test("Agent generation uses API path and generated candidates remain submit-compatible", async ({ page }) => {
  await page.goto(`${appUrl}?agent=1`);
  const prepared = await prepare(page, office, { version: 1, bounds: { x: 0, y: 0, width: 12, height: 10 } });
  const result = await page.evaluate((id) => {
    const agent = window.BlockPlanAgent;
    const before = window.BlockPlanAPI.listVariants();
    const generated = agent.callTool("generate_layout_candidates", { requirementsSnapshotId: id, requestedVariantCount: 1, maxStates: 16000 });
    const middle = window.BlockPlanAPI.listVariants();
    const submitted = generated.candidates.length ? agent.callTool("submit_generated_variants", { requirementsSnapshotId: id, candidates: generated.candidates }) : null;
    return { tools: agent.listTools().tools.map((tool) => tool.name), before, generated, middle, submitted };
  }, prepared.request.requirementsSnapshotId);
  expect(result.tools).toContain("generate_layout_candidates");
  expect(result.generated.ok).toBe(true);
  expect(result.middle).toEqual(result.before);
  expect(result.submitted).toMatchObject({ ok: true, variantIds: [expect.any(String)] });
});
