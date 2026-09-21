"use strict";

(function installGenerationModel() {
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  function emptyState() {
    return { version: 1, requirementsSnapshots: [], variants: [] };
  }

  function normalizeState(source) {
    const state = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    return {
      version: 1,
      requirementsSnapshots: Array.isArray(state.requirementsSnapshots) ? state.requirementsSnapshots.map((snapshot) => ({
        requirementsSnapshotId: snapshot.requirementsSnapshotId,
        version: snapshot.version === undefined ? 1 : snapshot.version,
        createdAt: snapshot.createdAt,
        metadata: clone(snapshot.metadata || {}),
        bubbles: (snapshot.bubbles || []).map(({ id, name, type, size, quantity, metadata }) => clone({ id, name, type, size, quantity, metadata })),
        connectors: (snapshot.connectors || []).map(({ id, fromBubbleId, toBubbleId, relationType, priority, direction, metadata }) =>
          clone({ id, fromBubbleId, toBubbleId, relationType, priority, direction, metadata }))
      })) : [],
      variants: Array.isArray(state.variants) ? state.variants.map((variant) => ({
        variantId: variant.variantId,
        requirementsSnapshotId: variant.requirementsSnapshotId,
        parentVariantId: variant.parentVariantId === undefined ? null : variant.parentVariantId,
        generationIndex: variant.generationIndex,
        strategy: variant.strategy,
        rationale: variant.rationale,
        generator: clone(variant.generator || {}),
        createdAt: variant.createdAt,
        blockPlan: {
          moduleSizeMm: variant.blockPlan && variant.blockPlan.moduleSizeMm,
          categories: clone((variant.blockPlan && variant.blockPlan.categories) || []),
          cells: clone((variant.blockPlan && variant.blockPlan.cells) || {}),
          zoneAssignments: clone((variant.blockPlan && variant.blockPlan.zoneAssignments) || {})
        }
      })) : []
    };
  }

  function requirementsFromDiagram(diagram) {
    return {
      bubbles: diagram.bubbles.map(({ id, name, type, size, quantity, metadata }) =>
        clone({ id, name, type, size, quantity, metadata })),
      connectors: diagram.connectors.map(({ id, fromBubbleId, toBubbleId, relationType, priority, direction, metadata }) =>
        clone({ id, fromBubbleId, toBubbleId, relationType, priority, direction, metadata }))
    };
  }

  function zonesFor(cells) {
    const zones = new Map();
    Object.entries(cells).forEach(([key, cell]) => {
      if (!cell.zoneId) return;
      if (!zones.has(cell.zoneId)) zones.set(cell.zoneId, []);
      zones.get(cell.zoneId).push(key);
    });
    zones.forEach((keys) => keys.sort());
    return zones;
  }

  function normalizeBlockPlan(input, snapshot) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("blockPlan is required");
    const moduleSizeMm = Number(input.moduleSizeMm);
    if (!Number.isFinite(moduleSizeMm) || moduleSizeMm <= 0) throw new Error("blockPlan.moduleSizeMm must be a positive number");
    if (!Array.isArray(input.categories) || !input.categories.length) throw new Error("blockPlan.categories must be a non-empty array");
    const categories = clone(input.categories);
    const categoryIds = new Set();
    categories.forEach((category) => {
      if (!category || typeof category.id !== "string" || !category.id.trim()) throw new Error("Every Variant category must have an id");
      if (categoryIds.has(category.id)) throw new Error(`Duplicate Variant category id: ${category.id}`);
      if (typeof category.name !== "string" || !category.name.trim()) throw new Error(`Variant category ${category.id} must have a name`);
      if (typeof category.color !== "string" || !/^#[0-9a-f]{6}$/i.test(category.color)) throw new Error(`Variant category ${category.id} must have a #RRGGBB color`);
      categoryIds.add(category.id);
    });
    if (!input.cells || typeof input.cells !== "object" || Array.isArray(input.cells)) throw new Error("blockPlan.cells must be an object");
    const cells = clone(input.cells);
    const zoneCategoryIds = new Map();
    Object.entries(cells).forEach(([key, cell]) => {
      if (!/^-?\d+,-?\d+$/.test(key)) throw new Error(`Invalid cell key: ${key}`);
      if (!cell || !categoryIds.has(cell.categoryId)) throw new Error(`Cell ${key} has unknown categoryId`);
      if (typeof cell.zoneId !== "string" || !cell.zoneId.trim()) throw new Error(`Cell ${key} must have a zoneId`);
      if (zoneCategoryIds.has(cell.zoneId) && zoneCategoryIds.get(cell.zoneId) !== cell.categoryId) {
        throw new Error(`Zone ${cell.zoneId} spans multiple categories`);
      }
      zoneCategoryIds.set(cell.zoneId, cell.categoryId);
    });
    if (input.zoneAssignments !== undefined && (!input.zoneAssignments || typeof input.zoneAssignments !== "object" || Array.isArray(input.zoneAssignments))) {
      throw new Error("blockPlan.zoneAssignments must be an object");
    }
    const zoneAssignments = clone(input.zoneAssignments || {});
    const zoneIds = new Set(zonesFor(cells).keys());
    const bubbleIds = new Set(snapshot.bubbles.map((bubble) => bubble.id));
    Object.entries(zoneAssignments).forEach(([zoneId, assignment]) => {
      if (!zoneIds.has(zoneId)) throw new Error(`Unknown Zone id: ${zoneId}`);
      if (!assignment || !bubbleIds.has(assignment.bubbleId)) throw new Error(`Unknown Bubble id: ${assignment && assignment.bubbleId}`);
    });
    return { moduleSizeMm, categories, cells, zoneAssignments };
  }

  function requireValidState(state) {
    const snapshotIds = new Set();
    state.requirementsSnapshots.forEach((snapshot) => {
      if (!snapshot || typeof snapshot.requirementsSnapshotId !== "string" || !snapshot.requirementsSnapshotId.trim()) throw new Error("Every Requirements Snapshot must have an id");
      if (snapshotIds.has(snapshot.requirementsSnapshotId)) throw new Error(`Duplicate requirementsSnapshotId: ${snapshot.requirementsSnapshotId}`);
      snapshotIds.add(snapshot.requirementsSnapshotId);
      if (!Array.isArray(snapshot.bubbles) || !Array.isArray(snapshot.connectors)) throw new Error(`Invalid Requirements Snapshot: ${snapshot.requirementsSnapshotId}`);
    });
    const variantIds = new Set();
    state.variants.forEach((variant) => {
      if (!variant || typeof variant.variantId !== "string" || !variant.variantId.trim()) throw new Error("Every Variant must have an id");
      if (variantIds.has(variant.variantId)) throw new Error(`Duplicate variantId: ${variant.variantId}`);
      variantIds.add(variant.variantId);
    });
    state.variants.forEach((variant) => {
      const snapshot = state.requirementsSnapshots.find((item) => item.requirementsSnapshotId === variant.requirementsSnapshotId);
      if (!snapshot) throw new Error(`Unknown requirementsSnapshotId: ${variant.requirementsSnapshotId}`);
      if (variant.parentVariantId !== null && !variantIds.has(variant.parentVariantId)) throw new Error(`Unknown parentVariantId: ${variant.parentVariantId}`);
      if (!Number.isInteger(variant.generationIndex) || variant.generationIndex < 0) throw new Error(`Invalid generationIndex for Variant: ${variant.variantId}`);
      variant.blockPlan = normalizeBlockPlan(variant.blockPlan, snapshot);
    });
    return state;
  }

  function point(key) { return key.split(",").map(Number); }
  function minimumDistance(a, b) {
    let minimum = Infinity;
    a.forEach((aKey) => {
      const [ax, ay] = point(aKey);
      b.forEach((bKey) => {
        const [bx, by] = point(bKey);
        minimum = Math.min(minimum, Math.abs(ax - bx) + Math.abs(ay - by));
      });
    });
    return Number.isFinite(minimum) ? minimum : null;
  }

  function validate(variant, snapshot) {
    const dataErrors = [];
    const hardViolations = [];
    const softIssues = [];
    const quantities = [];
    const sizes = [];
    const relationships = [];
    const block = variant.blockPlan;
    const zones = zonesFor(block.cells);
    const bubbleIds = new Set(snapshot.bubbles.map((bubble) => bubble.id));
    const assignedByBubble = new Map(snapshot.bubbles.map((bubble) => [bubble.id, []]));

    Object.entries(block.zoneAssignments).forEach(([zoneId, assignment]) => {
      if (!zones.has(zoneId)) dataErrors.push({ code: "unknown_zone", zoneId, message: `Unknown Zone id: ${zoneId}` });
      if (!assignment || !bubbleIds.has(assignment.bubbleId)) dataErrors.push({ code: "unknown_bubble", zoneId, bubbleId: assignment && assignment.bubbleId, message: `Unknown Bubble id: ${assignment && assignment.bubbleId}` });
      if (zones.has(zoneId) && assignment && bubbleIds.has(assignment.bubbleId)) assignedByBubble.get(assignment.bubbleId).push(zoneId);
    });

    snapshot.bubbles.forEach((bubble) => {
      const zoneIds = assignedByBubble.get(bubble.id).sort();
      const quantity = { bubbleId: bubble.id, target: bubble.quantity, actual: zoneIds.length, zoneIds };
      quantities.push(quantity);
      if (quantity.actual !== quantity.target) hardViolations.push({ code: "quantity_mismatch", ...quantity });
      const targetSqm = bubble.size && ["sqm", "m2", "m²"].includes(String(bubble.size.unit).toLowerCase()) ? bubble.size.value : null;
      if (targetSqm === null) dataErrors.push({ code: "unsupported_size_unit", bubbleId: bubble.id, unit: bubble.size && bubble.size.unit });
      zoneIds.forEach((zoneId) => {
        const actualSqm = zones.get(zoneId).length * Math.pow(block.moduleSizeMm / 1000, 2);
        sizes.push({
          bubbleId: bubble.id,
          zoneId,
          targetSqm,
          actualSqm,
          deltaSqm: targetSqm === null ? null : actualSqm - targetSqm,
          ratio: targetSqm === null ? null : actualSqm / targetSqm
        });
      });
    });

    snapshot.connectors.forEach((connector) => {
      const fromZones = assignedByBubble.get(connector.fromBubbleId) || [];
      const toZones = assignedByBubble.get(connector.toBubbleId) || [];
      let distance = null;
      let adjacentPairCount = 0;
      const adjacentFrom = new Set();
      const adjacentTo = new Set();
      fromZones.forEach((fromId) => toZones.forEach((toId) => {
        const candidate = minimumDistance(zones.get(fromId), zones.get(toId));
        if (candidate !== null) distance = distance === null ? candidate : Math.min(distance, candidate);
        if (candidate === 1) {
          adjacentPairCount += 1;
          adjacentFrom.add(fromId);
          adjacentTo.add(toId);
        }
      }));
      const metric = {
        connectorId: connector.id,
        relationType: connector.relationType,
        priority: connector.priority,
        minimumGridDistance: distance,
        minimumGridGap: distance === null ? null : Math.max(0, distance - 1),
        adjacentPairCount,
        fromCoverage: fromZones.length ? adjacentFrom.size / fromZones.length : 0,
        toCoverage: toZones.length ? adjacentTo.size / toZones.length : 0,
        evaluationStatus: fromZones.length && toZones.length ? "evaluated" : "not-evaluable",
        notEvaluableReason: !fromZones.length ? "from-bubble-has-no-assigned-zones" : !toZones.length ? "to-bubble-has-no-assigned-zones" : null
      };
      relationships.push(metric);
      if (metric.evaluationStatus === "not-evaluable") return;
      const touching = distance === 1;
      const failed = connector.relationType === "adjacent" ? !touching : connector.relationType === "separate" ? touching : false;
      if (failed) {
        const issue = { code: `${connector.relationType}_violation`, ...metric };
        (connector.priority === "required" ? hardViolations : softIssues).push(issue);
      }
    });

    const orphans = [...zones.keys()].filter((zoneId) => !Object.prototype.hasOwnProperty.call(block.zoneAssignments, zoneId)).sort();
    return { dataErrors, hardViolations, softIssues, metrics: { quantities, sizes, relationships, orphans } };
  }

  window.GenerationModel = { clone, emptyState, normalizeState, normalizeBlockPlan, requireValidState, requirementsFromDiagram, zonesFor, validate };
})();
