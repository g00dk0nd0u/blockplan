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
