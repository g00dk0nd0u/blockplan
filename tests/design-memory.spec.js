const { test, expect } = require("@playwright/test");
const path = require("path");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

async function seedReviewedVariant(page) {
  return page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.clear();
    api.setBubbleDiagram({
      version: 1,
      bubbles: [
        { id: "office", name: "Office", type: "office", size: { value: 20, unit: "sqm" }, quantity: 1, position: { x: 0, y: 0 }, metadata: {} },
        { id: "meeting", name: "Meeting", type: "meeting", size: { value: 10, unit: "sqm" }, quantity: 1, position: { x: 100, y: 0 }, metadata: {} }
      ],
      connectors: [
        { id: "relation-1", fromBubbleId: "office", toBubbleId: "meeting", relationType: "adjacent", priority: "preferred", direction: null, metadata: {} }
      ]
    });
    const snapshot = api.createRequirementsSnapshot().requirementsSnapshot;
    const variant = api.createVariant({
      variantId: "variant-reviewed",
      requirementsSnapshotId: snapshot.requirementsSnapshotId,
      blockPlan: {
        moduleSizeMm: 1000,
        categories: [
          { id: "office", name: "Office", color: "#AABB9C" },
          { id: "meeting", name: "Meeting", color: "#90B0C4" }
        ],
        cells: {
          "0,0": { categoryId: "office", zoneId: "zone-office" },
          "1,0": { categoryId: "meeting", zoneId: "zone-meeting" }
        },
        zoneAssignments: {
          "zone-office": { bubbleId: "office" },
          "zone-meeting": { bubbleId: "meeting" }
        }
      }
    }).variant;
    api.createReview({
      reviewId: "review-evidence",
      variantId: variant.variantId,
      decision: "iterate",
      good: ["Clear adjacency"],
      problems: ["Entry is tight"],
      nextInstructions: ["Keep office and meeting together"]
    });
    return { snapshotId: snapshot.requirementsSnapshotId, variantId: variant.variantId };
  });
}

test("old plans normalize empty Design Memory and Memory round-trips", async ({ page }) => {
  await page.goto(appUrl);
  const result = await page.evaluate(() => {
    const plan = window.BlockPlanAPI.getPlan();
    delete plan.memory;
    const loaded = window.BlockPlanAPI.setPlan(JSON.stringify(plan));
    return { loaded, plan: window.BlockPlanAPI.getPlan() };
  });
  expect(result.loaded.ok).toBe(true);
  expect(result.plan.memory).toEqual({ version: 1, items: [] });
});

test("Design Memory candidate lifecycle is evidence-backed, immutable after decision, and retrieval is deterministic", async ({ page }) => {
  await page.goto(appUrl);
  const seeded = await seedReviewedVariant(page);

  const result = await page.evaluate(({ snapshotId, variantId }) => {
    const api = window.BlockPlanAPI;
    const invalidEvidence = api.proposeMemoryFromReviews({
      scope: "project",
      type: "soft-preference",
      statement: "Keep related spaces together",
      evidenceReviewIds: ["missing-review"]
    });
    const proposed = api.proposeMemoryFromReviews({
      memoryId: "memory-project",
      scope: "project",
      type: "soft-preference",
      statement: "Keep office and meeting spaces directly adjacent",
      applicableConditions: { bubbleTypes: ["office"], relationTypes: ["adjacent"] },
      exceptions: ["Security separation may override"],
      strength: 0.8,
      evidenceReviewIds: ["review-evidence"]
    });
    proposed.memory.statement = "caller mutation";
    const beforeApproval = api.getRelevantMemory({ requirementsSnapshotId: snapshotId });
    const edited = api.updateMemoryCandidate("memory-project", { statement: "Prefer direct office / meeting adjacency", strength: 0.9 });
    const approved = api.approveMemory("memory-project");
    const editApproved = api.updateMemoryCandidate("memory-project", { statement: "should fail" });
    const rejectApproved = api.rejectMemory("memory-project");

    api.proposeMemoryFromReviews({
      memoryId: "memory-domain",
      scope: "domain",
      scopeKey: "office",
      type: "observed-pattern",
      statement: "Meeting rooms cluster near office neighborhoods",
      applicableConditions: { bubbleTypes: ["meeting"] },
      strength: 0.6,
      evidenceReviewIds: ["review-evidence"]
    });
    api.approveMemory("memory-domain");

    api.proposeMemoryFromReviews({
      memoryId: "memory-rejected",
      scope: "project",
      type: "rejected-pattern",
      statement: "Do not retain this candidate",
      evidenceReviewIds: ["review-evidence"]
    });
    api.rejectMemory("memory-rejected");

    const projectRelevant = api.getRelevantMemory({ requirementsSnapshotId: snapshotId });
    const wrongDomain = api.getRelevantMemory({ requirementsSnapshotId: snapshotId, domainKey: "data-center" });
    const rightDomain = api.getRelevantMemory({ requirementsSnapshotId: snapshotId, domainKey: "office" });
    const generationContext = api.getGenerationContext(snapshotId, { domainKey: "office" });
    const iterationContext = api.getIterationContext(variantId, { domainKey: "office" });
    const saved = api.getPlan();
    const roundTrip = api.setPlan(JSON.stringify(saved));
    return {
      invalidEvidence, beforeApproval, edited, approved, editApproved, rejectApproved,
      stored: api.getMemory("memory-project"), projectRelevant, wrongDomain, rightDomain,
      generationContext, iterationContext, roundTrip, items: api.listMemory()
    };
  }, seeded);

  expect(result.invalidEvidence.ok).toBe(false);
  expect(result.beforeApproval).toEqual([]);
  expect(result.edited.memory.statement).toBe("Prefer direct office / meeting adjacency");
  expect(result.approved.memory.status).toBe("approved");
  expect(result.editApproved.ok).toBe(false);
  expect(result.rejectApproved.ok).toBe(false);
  expect(result.stored.statement).toBe("Prefer direct office / meeting adjacency");
  expect(result.projectRelevant.map((item) => item.memoryId)).toEqual(["memory-project"]);
  expect(result.wrongDomain.map((item) => item.memoryId)).toEqual(["memory-project"]);
  expect(result.rightDomain.map((item) => item.memoryId)).toEqual(["memory-project", "memory-domain"]);
  expect(result.generationContext.relevantMemory.map((item) => item.memoryId)).toEqual(["memory-project", "memory-domain"]);
  expect(result.iterationContext.relevantMemory.map((item) => item.memoryId)).toEqual(["memory-project", "memory-domain"]);
  expect(result.roundTrip.ok).toBe(true);
  expect(result.items).toHaveLength(3);
  expect(result.items.find((item) => item.memoryId === "memory-rejected").status).toBe("rejected");

  await page.reload();
  const restored = await page.evaluate(() => window.BlockPlanAPI.listMemory());
  expect(restored.map((item) => item.memoryId).sort()).toEqual(["memory-domain", "memory-project", "memory-rejected"]);
});

test("Memory candidate dock supports human edit and approval", async ({ page }) => {
  await page.goto(appUrl);
  await seedReviewedVariant(page);
  await page.evaluate(() => window.BlockPlanAPI.proposeMemoryFromReviews({
    memoryId: "memory-ui",
    scope: "project",
    type: "soft-preference",
    statement: "Initial candidate",
    evidenceReviewIds: ["review-evidence"]
  }));

  const dock = page.getByTestId("memory-dock");
  await expect(dock).toBeVisible();
  await dock.locator("[data-memory-field='statement']").fill("Human edited preference");
  await dock.locator("[data-memory-field='strength']").fill("0.7");
  await dock.locator("[data-memory-approve]").click();
  await expect(dock).toBeHidden();

  const approved = await page.evaluate(() => window.BlockPlanAPI.getMemory("memory-ui"));
  expect(approved).toMatchObject({ statement: "Human edited preference", strength: 0.7, status: "approved" });
});

test("persisted Memory validation is strict and atomic", async ({ page }) => {
  await page.goto(appUrl);
  await seedReviewedVariant(page);
  const result = await page.evaluate(() => {
    const api = window.BlockPlanAPI;
    api.proposeMemoryFromReviews({
      memoryId: "memory-valid",
      scope: "project",
      type: "hard-rule",
      statement: "Retain the valid record",
      evidenceReviewIds: ["review-evidence"]
    });
    api.approveMemory("memory-valid");
    const baseline = api.getPlan();
    const invalidPlans = [
      { ...baseline, memory: { ...baseline.memory, version: 2 } },
      { ...baseline, memory: { ...baseline.memory, items: [...baseline.memory.items, baseline.memory.items[0]] } },
      { ...baseline, memory: { ...baseline.memory, items: baseline.memory.items.map((item) => ({ ...item, status: "active" })) } },
      { ...baseline, memory: { ...baseline.memory, items: baseline.memory.items.map((item) => ({ ...item, strength: "0.8" })) } },
      { ...baseline, memory: { ...baseline.memory, items: baseline.memory.items.map((item) => ({ ...item, evidenceReviewIds: [] })) } },
      { ...baseline, memory: { ...baseline.memory, items: baseline.memory.items.map((item) => ({ ...item, evidenceReviewIds: ["missing"] })) } },
      { ...baseline, memory: { ...baseline.memory, items: baseline.memory.items.map((item) => ({ ...item, applicableConditions: { bubbleTypes: [], relationTypes: "adjacent", tags: [] } })) } },
      { ...baseline, memory: { ...baseline.memory, items: baseline.memory.items.map((item) => ({ ...item, updatedAt: "not-a-date" })) } }
    ];
    const failures = invalidPlans.map((candidate) => api.setPlan(candidate));
    return { failures, unchanged: JSON.stringify(api.getPlan()) === JSON.stringify(baseline) };
  });
  expect(result.failures.every((entry) => entry.ok === false)).toBe(true);
  expect(result.unchanged).toBe(true);
});

test("malformed localStorage Memory does not partially restore its Plan", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("blockplan.currentPlan.v1", JSON.stringify({
      version: 1,
      moduleSizeMm: 999,
      categories: [{ id: "office", name: "Office", color: "#AABB9C" }],
      cells: { "99,99": { categoryId: "office", zoneId: "should-not-restore" } },
      bubbleDiagram: { version: 1, bubbles: [], connectors: [] },
      generation: { version: 1, requirementsSnapshots: [], variants: [] },
      review: { version: 1, reviews: [] },
      memory: { version: 2, items: [] }
    }));
  });
  await page.goto(appUrl);
  const plan = await page.evaluate(() => window.BlockPlanAPI.getPlan());
  expect(plan.moduleSizeMm).toBe(3600);
  expect(plan.cells).toEqual({});
  expect(plan.memory).toEqual({ version: 1, items: [] });
});

test("retrieval applies all deterministic conditions and returns defensive clones", async ({ page }) => {
  await page.goto(appUrl);
  const seeded = await seedReviewedVariant(page);
  const result = await page.evaluate(({ snapshotId }) => {
    const api = window.BlockPlanAPI;
    const proposals = [
      { memoryId: "memory-z", strength: 0.5, applicableConditions: { tags: ["quiet"] } },
      { memoryId: "memory-a", strength: 0.5, applicableConditions: { bubbleTypes: ["office"], relationTypes: ["adjacent"] } },
      { memoryId: "memory-high", strength: 0.9, applicableConditions: {} },
      { memoryId: "memory-other-type", strength: 1, applicableConditions: { bubbleTypes: ["laboratory"] } },
      { memoryId: "memory-other-relation", strength: 1, applicableConditions: { relationTypes: ["separate"] } },
      { memoryId: "memory-domain", strength: 1, scope: "domain", scopeKey: "workplace", applicableConditions: {} },
      { memoryId: "memory-designer", strength: 1, scope: "designer", scopeKey: "alex", applicableConditions: {} }
    ];
    proposals.forEach((entry) => {
      api.proposeMemoryFromReviews({
        scope: "project", type: "soft-preference", statement: entry.memoryId,
        evidenceReviewIds: ["review-evidence"], ...entry
      });
      api.approveMemory(entry.memoryId);
    });
    api.proposeMemoryFromReviews({ memoryId: "memory-candidate", scope: "project", type: "soft-preference", statement: "candidate", evidenceReviewIds: ["review-evidence"] });
    const matched = api.getRelevantMemory({ requirementsSnapshotId: snapshotId, tags: ["quiet"], domainKey: "workplace", designerKey: "alex" });
    matched[0].statement = "caller mutation";
    const unmatchedKeys = api.getRelevantMemory({ requirementsSnapshotId: snapshotId, tags: ["quiet"] });
    const stored = api.getMemory("memory-domain");
    stored.statement = "caller mutation";
    return {
      matchedIds: matched.map((item) => item.memoryId),
      unmatchedKeyIds: unmatchedKeys.map((item) => item.memoryId),
      storedAgain: api.getMemory("memory-domain"),
      candidateVisible: api.getRelevantMemory({ requirementsSnapshotId: snapshotId }).some((item) => item.memoryId === "memory-candidate")
    };
  }, seeded);
  expect(result.matchedIds).toEqual(["memory-designer", "memory-domain", "memory-high", "memory-a", "memory-z"]);
  expect(result.unmatchedKeyIds).toEqual(["memory-high", "memory-a", "memory-z"]);
  expect(result.storedAgain.statement).toBe("memory-domain");
  expect(result.candidateVisible).toBe(false);
});

test("Memory decisions survive an unrelated shared Undo", async ({ page }) => {
  await page.goto(appUrl);
  await seedReviewedVariant(page);
  const setup = await page.evaluate(() => {
    pushUndoState();
    const proposed = window.BlockPlanAPI.proposeMemoryFromReviews({
      memoryId: "memory-after-snapshot", scope: "project", type: "observed-pattern",
      statement: "Preserve across geometry undo", evidenceReviewIds: ["review-evidence"]
    });
    const approved = window.BlockPlanAPI.approveMemory("memory-after-snapshot");
    window.BlockPlanAPI.paintRect({ x: 9, y: 9, width: 1, height: 1, categoryId: "office", zoneId: "undo-zone" });
    return { proposed, approved };
  });
  expect(setup.proposed.ok).toBe(true);
  expect(setup.approved.ok).toBe(true);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  expect(await page.evaluate(() => window.BlockPlanAPI.getMemory("memory-after-snapshot").status)).toBe("approved");
});

test("candidate dock rejects a candidate and disappears", async ({ page }) => {
  await page.goto(appUrl);
  await seedReviewedVariant(page);
  await page.evaluate(() => window.BlockPlanAPI.proposeMemoryFromReviews({
    memoryId: "memory-ui-reject", scope: "project", type: "rejected-pattern",
    statement: "Reject this", evidenceReviewIds: ["review-evidence"]
  }));
  const dock = page.getByTestId("memory-dock");
  await expect(dock).toContainText("Evidence: review-evidence");
  await dock.locator("[data-memory-reject]").click();
  await expect(dock).toBeHidden();
  expect(await page.evaluate(() => window.BlockPlanAPI.getMemory("memory-ui-reject").status)).toBe("rejected");
});
