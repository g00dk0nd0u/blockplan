const { test, expect } = require("@playwright/test");
const path = require("path");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

async function seedDiagram(page) {
  return page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.setModuleSize(1000);
    return api.setBubbleDiagram({
      version: 1,
      bubbles: [
        { id: "office", name: "Office", type: "office", size: { value: 2, unit: "sqm" }, quantity: 1, position: { x: 120, y: 180 }, metadata: { daylight: true } },
        { id: "meeting", name: "Meeting", type: "meeting", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 380, y: 180 }, metadata: {} }
      ],
      connectors: [
        { id: "connection-1", fromBubbleId: "office", toBubbleId: "meeting", relationType: "adjacent", priority: "required", direction: null, metadata: {} }
      ]
    });
  });
}

function candidate(strategy, offset = 0) {
  return {
    strategy,
    rationale: `${strategy} rationale`,
    generator: { name: "test-agent" },
    blockPlan: {
      moduleSizeMm: 1000,
      categories: [
        { id: "office", name: "Office", color: "#AABB9C" },
        { id: "meeting", name: "Meeting", color: "#90B0C4" }
      ],
      cells: {
        [`${offset},0`]: { categoryId: "office", zoneId: `office-${strategy}` },
        [`${offset + 1},0`]: { categoryId: "office", zoneId: `office-${strategy}` },
        [`${offset + 2},0`]: { categoryId: "meeting", zoneId: `meeting-${strategy}` }
      },
      zoneAssignments: {
        [`office-${strategy}`]: { bubbleId: "office" },
        [`meeting-${strategy}`]: { bubbleId: "meeting" }
      }
    }
  };
}

test("Agent IO panel is opt-in and agent mode preloads tool/resource discovery", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByTestId("agent-io-panel")).toBeHidden();
  await expect(page.getByTestId("generate-block-plans")).toBeHidden();
  expect(await page.evaluate(() => window.BlockPlanAgent.listTools().tools.map((tool) => tool.name))).toEqual([
    "prepare_generation_request", "get_generation_request", "submit_generated_variants",
    "get_variant_validation", "get_layout_problem", "evaluate_layout_variant", "generate_layout_candidates", "activate_variant", "get_iteration_request"
  ]);

  await page.goto(`${appUrl}?agent=1`);
  await expect(page.getByTestId("agent-io-panel")).toBeVisible();
  await expect(page.getByTestId("agent-io-discovery")).toContainText("prepare_generation_request");
  const resources = await page.evaluate(() => window.BlockPlanAgent.execute({ action: "list_resources" }));
  expect(resources.resources.map((resource) => resource.uri)).toEqual([
    "blockplan://generation/latest-request", "blockplan://bubble-diagram", "blockplan://variants"
  ]);
});

test("prepare creates one immutable semantic request, defaults to three, and get does not mutate", async ({ page }) => {
  await page.goto(`${appUrl}?agent=1`);
  await seedDiagram(page);
  const result = await page.evaluate(() => {
    const before = window.BlockPlanAPI.getPlan();
    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", {});
    prepared.request.requirements.bubbles[0].name = "caller mutation";
    const afterPrepare = window.BlockPlanAPI.getPlan();
    const fetched = window.BlockPlanAgent.callTool("get_generation_request", {
      requirementsSnapshotId: prepared.request.requirementsSnapshotId
    });
    const afterGet = window.BlockPlanAPI.getPlan();
    return { before, prepared, afterPrepare, fetched, afterGet };
  });

  expect(result.prepared.ok).toBe(true);
  expect(result.prepared.request.contract).toBe("blockplan.generation-request/v1");
  expect(result.prepared.request.requestedVariantCount).toBe(3);
  expect(result.afterPrepare.generation.requirementsSnapshots).toHaveLength(result.before.generation.requirementsSnapshots.length + 1);
  expect(result.afterGet.generation.requirementsSnapshots).toHaveLength(result.afterPrepare.generation.requirementsSnapshots.length);
  expect(result.fetched.request.requirements.bubbles[0]).toMatchObject({ name: "Office", type: "office", quantity: 1, metadata: { daylight: true } });
  expect(result.fetched.request.requirements.bubbles[0]).not.toHaveProperty("position");
  expect(result.fetched.request.requirements.connectors[0]).toMatchObject({ relationType: "adjacent", priority: "required" });
  expect(result.fetched.request).toMatchObject({ moduleSizeMm: 1000, categories: expect.any(Array), candidateOutput: expect.any(Object) });
  expect(result.afterGet.bubbleDiagram).toEqual(result.before.bubbleDiagram);
});

test("prepared requests freeze module size and categories in immutable Snapshot metadata", async ({ page }) => {
  await page.goto(appUrl);
  await seedDiagram(page);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.setModuleSize(1200);
    const planA = api.getPlan();
    planA.categories = [
      { id: "program-a", name: "Program A", color: "#123456" },
      { id: "support-a", name: "Support A", color: "#ABCDEF" }
    ];
    api.setPlan(planA);

    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", {});
    const snapshotId = prepared.request.requirementsSnapshotId;
    const snapshotBefore = api.getRequirementsSnapshot(snapshotId);
    const semanticBefore = JSON.parse(JSON.stringify(snapshotBefore.bubbles));

    const planB = api.getPlan();
    planB.moduleSizeMm = 2400;
    planB.categories = [{ id: "program-b", name: "Program B", color: "#654321" }];
    api.setPlan(planB);

    const fetched = window.BlockPlanAgent.callTool("get_generation_request", { requirementsSnapshotId: snapshotId });
    const snapshotAfter = api.getRequirementsSnapshot(snapshotId);
    return { prepared, fetched, snapshotBefore, snapshotAfter, semanticBefore, current: api.getPlan() };
  });

  const frozenCategories = [
    { id: "program-a", name: "Program A", color: "#123456" },
    { id: "support-a", name: "Support A", color: "#ABCDEF" }
  ];
  expect(result.snapshotBefore.metadata).toEqual({
    purpose: "ai-generation",
    generationContext: { version: 1, moduleSizeMm: 1200, categories: frozenCategories }
  });
  expect(result.current).toMatchObject({ moduleSizeMm: 2400, categories: [{ id: "program-b" }] });
  expect(result.fetched.request).toMatchObject({ moduleSizeMm: 1200, categories: frozenCategories });
  expect(result.snapshotAfter).toEqual(result.snapshotBefore);
  expect(result.fetched.request.requirements.bubbles).toEqual(result.semanticBefore);
  expect(result.fetched.request.requirements.bubbles.every((bubble) => !("position" in bubble))).toBe(true);
});

test("legacy Snapshot without generationContext falls back without mutating the Snapshot", async ({ page }) => {
  await page.goto(appUrl);
  await seedDiagram(page);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const legacy = api.createRequirementsSnapshot({ metadata: { purpose: "legacy" } }).requirementsSnapshot;
    api.setModuleSize(1800);
    const current = api.getPlan();
    current.categories = [{ id: "legacy-fallback", name: "Legacy Fallback", color: "#345678" }];
    api.setPlan(current);
    const request = window.BlockPlanAgent.callTool("get_generation_request", {
      requirementsSnapshotId: legacy.requirementsSnapshotId
    });
    return { legacy, stored: api.getRequirementsSnapshot(legacy.requirementsSnapshotId), request };
  });

  expect(result.request).toMatchObject({
    ok: true,
    request: {
      moduleSizeMm: 1800,
      categories: [{ id: "legacy-fallback", name: "Legacy Fallback", color: "#345678" }]
    }
  });
  expect(result.stored).toEqual(result.legacy);
  expect(result.stored.metadata).toEqual({ purpose: "legacy" });
});

test("generation request includes only deterministically relevant approved Memory", async ({ page }) => {
  await page.goto(appUrl);
  await seedDiagram(page);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", {});
    const snapshotId = prepared.request.requirementsSnapshotId;
    const blockPlan = {
      moduleSizeMm: 1000,
      categories: [{ id: "office", name: "Office", color: "#AABB9C" }],
      cells: { "0,0": { categoryId: "office", zoneId: "z" } },
      zoneAssignments: { z: { bubbleId: "office" } }
    };
    const variant = api.createVariant({ requirementsSnapshotId: snapshotId, blockPlan }).variant;
    const review = api.createReview({ variantId: variant.variantId, decision: "iterate", nextInstructions: ["Keep daylight"] }).review;
    ["approved", "candidate", "rejected"].forEach((status) => {
      api.proposeMemoryFromReviews({ memoryId: `memory-${status}`, scope: "project", type: "soft-preference", statement: status, applicableConditions: { bubbleTypes: ["office"] }, evidenceReviewIds: [review.reviewId] });
      if (status === "approved") api.approveMemory(`memory-${status}`);
      if (status === "rejected") api.rejectMemory(`memory-${status}`);
    });
    return window.BlockPlanAgent.callTool("get_generation_request", { requirementsSnapshotId: snapshotId });
  });
  expect(result.request.relevantMemory.map((memory) => memory.memoryId)).toEqual(["memory-approved"]);
});

test("multi-candidate submission is atomic, immutable, and does not activate", async ({ page }) => {
  await page.goto(appUrl);
  await seedDiagram(page);
  const candidates = [candidate("compact", 0), candidate("courtyard", 10), candidate("linear", 20)];
  const result = await page.evaluate((submitted) => {
    const prepared = window.BlockPlanAgent.callTool("prepare_generation_request", {});
    const request = prepared.request;
    const before = window.BlockPlanAPI.getPlan();
    const accepted = window.BlockPlanAgent.callTool("submit_generated_variants", {
      requirementsSnapshotId: request.requirementsSnapshotId,
      candidates: submitted
    });
    const after = window.BlockPlanAPI.getPlan();
    const malformed = JSON.parse(JSON.stringify(submitted));
    delete malformed[1].blockPlan.zoneAssignments["office-courtyard"];
    const rejected = window.BlockPlanAgent.callTool("submit_generated_variants", {
      requirementsSnapshotId: request.requirementsSnapshotId,
      candidates: malformed
    });
    const finalPlan = window.BlockPlanAPI.getPlan();
    return { request, before, accepted, after, rejected, finalPlan };
  }, candidates);

  expect(result.accepted.ok).toBe(true);
  expect(new Set(result.accepted.variantIds).size).toBe(3);
  expect(result.accepted.variants.map((variant) => variant.requirementsSnapshotId)).toEqual(Array(3).fill(result.request.requirementsSnapshotId));
  expect(result.accepted.variants.map((variant) => variant.strategy)).toEqual(["compact", "courtyard", "linear"]);
  expect(result.accepted.variants.map((variant) => variant.rationale)).toEqual(["compact rationale", "courtyard rationale", "linear rationale"]);
  expect(result.after.cells).toEqual(result.before.cells);
  expect(result.after.bubbleDiagram).toEqual(result.before.bubbleDiagram);
  expect(result.rejected).toMatchObject({ ok: false, code: "INVALID_VARIANT_SUBMISSION" });
  expect(result.finalPlan.generation.variants).toHaveLength(3);
  expect(result.finalPlan.cells).toEqual(result.before.cells);
});

test("validation stays derived, activation reuses API behavior, and iteration children retain lineage", async ({ page }) => {
  await page.goto(appUrl);
  await seedDiagram(page);
  const result = await page.evaluate((rootCandidate) => {
    const agent = window.BlockPlanAgent;
    const api = window.BlockPlanAPI;
    const request = agent.callTool("prepare_generation_request", {}).request;
    const root = agent.callTool("submit_generated_variants", { requirementsSnapshotId: request.requirementsSnapshotId, candidates: [rootCandidate] }).variants[0];
    const validation = agent.callTool("get_variant_validation", { variantId: root.variantId });
    const storedBefore = api.getVariant(root.variantId);
    const activation = agent.callTool("activate_variant", { variantId: root.variantId });
    const review = api.createReview({ variantId: root.variantId, decision: "iterate", good: ["Clear"], nextInstructions: ["Try another organization"] }).review;
    api.proposeMemoryFromReviews({ memoryId: "iteration-memory", scope: "project", type: "soft-preference", statement: "Retain clarity", evidenceReviewIds: [review.reviewId] });
    api.approveMemory("iteration-memory");
    const iteration = agent.callTool("get_iteration_request", { variantId: root.variantId, requestedVariantCount: 2 });
    const childCandidate = JSON.parse(JSON.stringify(rootCandidate));
    childCandidate.strategy = "iterated";
    childCandidate.rationale = "Responds to review";
    const child = agent.callTool("submit_generated_variants", {
      requirementsSnapshotId: iteration.request.requirementsSnapshotId,
      parentVariantId: iteration.request.parentVariantId,
      candidates: [childCandidate]
    }).variants[0];
    const saved = api.getPlan();
    const loaded = api.setPlan(JSON.stringify(saved));
    return { validation, storedBefore, activation, active: api.getPlan(), review, iteration, child, loaded };
  }, candidate("root", 4));

  expect(result.validation).toMatchObject({ ok: true, validation: { dataErrors: [], hardViolations: [], softIssues: [], metrics: expect.any(Object) } });
  expect(result.storedBefore).not.toHaveProperty("validation");
  expect(result.activation.ok).toBe(true);
  expect(result.active.cells).toEqual(result.storedBefore.blockPlan.cells);
  expect(result.iteration.request).toMatchObject({
    requestType: "iteration", requestedVariantCount: 2,
    requirementsSnapshotId: result.storedBefore.requirementsSnapshotId,
    parentVariantId: result.storedBefore.variantId,
    currentValidation: expect.any(Object), candidateOutput: expect.any(Object)
  });
  expect(result.iteration.request.lineage.map((variant) => variant.variantId)).toEqual([result.storedBefore.variantId]);
  expect(result.iteration.request.reviews.map((review) => review.reviewId)).toEqual([result.review.reviewId]);
  expect(result.iteration.request.relevantMemory.map((memory) => memory.memoryId)).toEqual(["iteration-memory"]);
  expect(result.child.parentVariantId).toBe(result.storedBefore.variantId);
  expect(result.child.requirementsSnapshotId).toBe(result.storedBefore.requirementsSnapshotId);
  expect(result.loaded.ok).toBe(true);
  expect(result.active.generation.variants).toHaveLength(2);
  expect(result.active.review.reviews).toHaveLength(1);
  expect(result.active.memory.items).toHaveLength(1);
});

test("Generate Block Plans prepares a request and reports readiness without pretending generation", async ({ page }) => {
  await page.goto(`${appUrl}?agent=1`);
  await seedDiagram(page);
  await page.getByTestId("mode-bubble").click();
  await expect(page.getByTestId("generate-block-plans")).toBeVisible();
  await page.getByTestId("generate-block-plans").click();
  await expect(page.getByTestId("generation-ready-status")).toHaveText(/AI request ready · requirements-/);
  const state = await page.evaluate(() => ({
    latest: window.BlockPlanAgent.readResource("blockplan://generation/latest-request"),
    variants: window.BlockPlanAPI.listVariants()
  }));
  expect(state.latest.ok).toBe(true);
  expect(state.variants).toEqual([]);
});

test("CustomEvent bridge accepts MCP-style tool calls", async ({ page }) => {
  await page.goto(`${appUrl}?agent=1`);
  const response = await page.evaluate(() => new Promise((resolve) => {
    document.addEventListener("blockplan:agent-result", (event) => resolve(event.detail), { once: true });
    document.dispatchEvent(new CustomEvent("blockplan:agent-request", {
      detail: { id: "test-call", command: { tool: "get_generation_request", arguments: { requirementsSnapshotId: "missing" } } }
    }));
  }));
  expect(response).toMatchObject({ id: "test-call", ok: false, result: { code: "REQUEST_NOT_FOUND" } });
});
