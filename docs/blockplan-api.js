"use strict";

(function installBlockPlanApi() {
  function success(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, ...value } : { ok: true, value };
  }

  function failure(error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }

  function sync(status) {
    selectedZoneSignature = null;
    transformDraft = null;
    paintStrokeZoneId = null;
    if (typeof patchSelectedZoneIds !== "undefined") patchSelectedZoneIds.clear();
    persistPlan();
    renderCategoryList();
    updateUi();
    if (typeof window.refreshBubbleEditor === "function") window.refreshBubbleEditor();
    if (typeof window.refreshReviewDock === "function") window.refreshReviewDock();
    if (status) showSaveStatus(status);
  }

  function requireCategory(categoryId) {
    if (!plan.categories.some((category) => category.id === categoryId)) {
      throw new Error(`Unknown categoryId: ${categoryId}`);
    }
  }

  function requirePositiveRect(rect) {
    ["x", "y", "width", "height"].forEach((name) => {
      if (!Number.isInteger(rect[name])) throw new Error(`${name} must be an integer`);
    });
    if (rect.width <= 0 || rect.height <= 0) throw new Error("width and height must be positive integers");
  }

  function zoneDetails(zone) {
    return {
      zoneId: zone.id,
      categoryId: zone.categoryId,
      cellKeys: [...zone.cellKeys].sort(),
      bounds: getBoundsForKeys(zone.cellKeys),
      areaSqm: zone.cellKeys.length * getCellAreaSqm()
    };
  }

  function getZonesInternal() {
    return calculateZones().map(zoneDetails).sort((a, b) => a.zoneId.localeCompare(b.zoneId));
  }

  function connectedZones(zones) {
    if (typeof areZonesContiguous === "function") return areZonesContiguous(zones);
    if (zones.length < 2) return false;
    const visited = new Set([zones[0].id]);
    const stack = [zones[0]];
    while (stack.length) {
      const current = stack.pop();
      const keys = new Set(current.cellKeys);
      zones.forEach((zone) => {
        if (visited.has(zone.id)) return;
        if (zone.cellKeys.some((key) => {
          const [x, y] = parseCellKey(key);
          return keys.has(cellKey(x + 1, y)) || keys.has(cellKey(x - 1, y)) || keys.has(cellKey(x, y + 1)) || keys.has(cellKey(x, y - 1));
        })) {
          visited.add(zone.id);
          stack.push(zone);
        }
      });
    }
    return visited.size === zones.length;
  }

  function exportCanvasDataUrl() {
    const exportCanvas = document.createElement("canvas");
    const bounds = getCellBounds();
    const padding = 40;
    const width = Math.max(900, bounds.width * CELL_PX + padding * 2);
    const height = Math.max(640, bounds.height * CELL_PX + padding * 2);
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext("2d");
    exportCtx.fillStyle = CANVAS_BACKGROUND;
    exportCtx.fillRect(0, 0, width, height);
    exportCtx.translate(padding - bounds.minX * CELL_PX, padding - bounds.minY * CELL_PX);
    drawExportGrid(exportCtx, bounds);
    drawZonesOnContext(exportCtx, calculateZones());
    return exportCanvas.toDataURL("image/png");
  }

  function nextDiagramId(prefix, items) {
    const ids = new Set(items.map((item) => item.id));
    let number = 1;
    while (ids.has(`${prefix}-${number}`)) number += 1;
    return `${prefix}-${number}`;
  }

  function nextGenerationId(prefix, items, field) {
    const ids = new Set(items.map((item) => item[field]));
    let number = 1;
    while (ids.has(`${prefix}-${number}`)) number += 1;
    return `${prefix}-${number}`;
  }

  function findSnapshot(id) {
    const snapshot = plan.generation.requirementsSnapshots.find((item) => item.requirementsSnapshotId === id);
    if (!snapshot) throw new Error(`Unknown requirementsSnapshotId: ${id}`);
    return snapshot;
  }

  function findVariant(id) {
    const variant = plan.generation.variants.find((item) => item.variantId === id);
    if (!variant) throw new Error(`Unknown variantId: ${id}`);
    return variant;
  }

  function findReview(id) {
    const review = plan.review.reviews.find((item) => item.reviewId === id);
    if (!review) throw new Error(`Unknown reviewId: ${id}`);
    return review;
  }

  function nextGenerationIndex() {
    return plan.generation.variants.reduce((maximum, variant) => Math.max(maximum, variant.generationIndex), 0) + 1;
  }

  function requireCompleteGeneratedBlockPlan(input, snapshot) {
    const allowed = new Set(["moduleSizeMm", "categories", "cells", "zoneAssignments"]);
    Object.keys(input || {}).forEach((key) => {
      if (!allowed.has(key)) throw new Error(`Unsupported blockPlan field: ${key}`);
    });
    const blockPlan = GenerationModel.normalizeBlockPlan(input, snapshot);
    const zones = GenerationModel.zonesFor(blockPlan.cells);
    zones.forEach((keys, zoneId) => {
      if (!Object.prototype.hasOwnProperty.call(blockPlan.zoneAssignments, zoneId)) {
        throw new Error(`Zone ${zoneId} must have a Bubble assignment`);
      }
      const remaining = new Set(keys);
      const stack = [keys[0]];
      remaining.delete(keys[0]);
      while (stack.length) {
        const [x, y] = stack.pop().split(",").map(Number);
        [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].forEach(([nx, ny]) => {
          const key = `${nx},${ny}`;
          if (remaining.delete(key)) stack.push(key);
        });
      }
      if (remaining.size) throw new Error(`Zone ${zoneId} must be contiguous`);
    });
    return blockPlan;
  }

  const api = {
    version: 1,

    getPlan() {
      try { return serializePlanForSave(); } catch (error) { return failure(error); }
    },

    setPlan(planJson) {
      try {
        const source = typeof planJson === "string" ? JSON.parse(planJson) : planJson;
        const candidate = normalizePlan(source);
        plan = candidate;
        if (typeof clearUndoHistory === "function") clearUndoHistory();
        activeCategoryId = plan.categories[0] ? plan.categories[0].id : "unassigned";
        sync("API plan loaded");
        return success({ plan: serializePlanForSave() });
      } catch (error) { return failure(error); }
    },

    clear(options = {}) {
      try {
        plan.cells = {};
        if (!options.keepCategories) plan.categories = clonePlan(defaultPlan).categories;
        activeCategoryId = plan.categories[0] ? plan.categories[0].id : "unassigned";
        sync("API cleared");
        return success({ plan: serializePlanForSave() });
      } catch (error) { return failure(error); }
    },

    setModuleSize(mm) {
      try {
        const next = Number(mm);
        if (!Number.isFinite(next) || next <= 0) throw new Error("Module size must be a positive number");
        plan.moduleSizeMm = next;
        sync("API module size updated");
        return success({ moduleSizeMm: plan.moduleSizeMm });
      } catch (error) { return failure(error); }
    },

    addCategory(input) {
      try {
        const baseId = String(input && input.id ? input.id : `category-${plan.categories.length + 1}`).trim();
        if (!baseId) throw new Error("Category id is required");
        const id = typeof createUniqueCategoryId === "function" ? createUniqueCategoryId(baseId) : baseId;
        if (id !== baseId && plan.categories.some((category) => category.id === baseId)) throw new Error(`Duplicate category id: ${baseId}`);
        const category = { id, name: String(input.name || id), color: String(input.color || "#78909C") };
        if (!/^#[0-9a-f]{6}$/i.test(category.color)) throw new Error("Category color must be a #RRGGBB hex value");
        plan.categories.push(category);
        activeCategoryId = id;
        sync("API category added");
        return success({ category });
      } catch (error) { return failure(error); }
    },

    paintRect(rect) {
      try {
        requirePositiveRect(rect);
        requireCategory(rect.categoryId);
        const zoneId = rect.zoneId ? String(rect.zoneId) : createZoneId();
        const affectedZoneIds = new Set();
        for (let y = rect.y; y < rect.y + rect.height; y += 1) {
          for (let x = rect.x; x < rect.x + rect.width; x += 1) {
            const key = cellKey(x, y);
            if (plan.cells[key] && plan.cells[key].zoneId !== zoneId) affectedZoneIds.add(plan.cells[key].zoneId);
            plan.cells[key] = { categoryId: rect.categoryId, zoneId };
          }
        }
        affectedZoneIds.forEach(splitZoneIntoConnectedComponents);
        sync("API painted");
        return success({ zoneId, cellCount: rect.width * rect.height });
      } catch (error) { return failure(error); }
    },

    eraseRect(rect) {
      try {
        requirePositiveRect(rect);
        const affectedZoneIds = new Set();
        for (let y = rect.y; y < rect.y + rect.height; y += 1) {
          for (let x = rect.x; x < rect.x + rect.width; x += 1) {
            const key = cellKey(x, y);
            if (plan.cells[key]) affectedZoneIds.add(plan.cells[key].zoneId);
            delete plan.cells[key];
          }
        }
        affectedZoneIds.forEach(splitZoneIntoConnectedComponents);
        sync("API erased");
        return success({ erased: true });
      } catch (error) { return failure(error); }
    },

    moveZone({ zoneId, dx, dy }) {
      try {
        if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error("dx and dy must be integers");
        const zone = calculateZones().find((item) => item.id === zoneId);
        if (!zone) throw new Error(`Unknown zoneId: ${zoneId}`);
        const destinationKeys = offsetCellKeys(zone.cellKeys, dx, dy);
        if (!canPlaceCellKeys(destinationKeys, new Set(zone.cellKeys))) throw new Error("Move would overlap existing cells");
        zone.cellKeys.forEach((key) => delete plan.cells[key]);
        destinationKeys.forEach((key) => { plan.cells[key] = { categoryId: zone.categoryId, zoneId }; });
        sync("API zone moved");
        return success({ zoneId });
      } catch (error) { return failure(error); }
    },

    copyZone({ zoneId, dx, dy, newZoneId }) {
      try {
        if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error("dx and dy must be integers");
        const zone = calculateZones().find((item) => item.id === zoneId);
        if (!zone) throw new Error(`Unknown zoneId: ${zoneId}`);
        const destinationKeys = offsetCellKeys(zone.cellKeys, dx, dy);
        if (!canPlaceCellKeys(destinationKeys, new Set())) throw new Error("Copy would overlap existing cells");
        let copyId = createZoneId();
        if (newZoneId !== undefined) {
          copyId = String(newZoneId).trim();
          if (!copyId) throw new Error("newZoneId must not be empty");
          if (calculateZones().some((item) => item.id === copyId)) {
            throw new Error(`newZoneId already exists: ${copyId}`);
          }
        }
        destinationKeys.forEach((key) => { plan.cells[key] = { categoryId: zone.categoryId, zoneId: copyId }; });
        sync("API zone copied");
        return success({ zoneId: copyId });
      } catch (error) { return failure(error); }
    },

    rotateZone({ zoneId, steps }) {
      try {
        const zone = calculateZones().find((item) => item.id === zoneId);
        if (!zone) throw new Error(`Unknown zoneId: ${zoneId}`);
        const result = applyZoneRotation(zone, Number(steps) || 0);
        if (result.status === "blocked") throw new Error("Rotation would overlap existing cells");
        sync("API zone rotated");
        return success({ zoneId, status: result.status });
      } catch (error) { return failure(error); }
    },

    mergeZones(zoneIds) {
      try {
        if (!Array.isArray(zoneIds) || zoneIds.length < 2) throw new Error("At least two zoneIds are required");
        const ids = new Set(zoneIds.map(String));
        const zones = calculateZones().filter((zone) => ids.has(zone.id));
        if (zones.length !== ids.size) throw new Error("One or more zoneIds were not found");
        const categoryId = zones[0].categoryId;
        if (!zones.every((zone) => zone.categoryId === categoryId)) throw new Error("Merge requires same category");
        if (!connectedZones(zones)) throw new Error("Merge requires connected zones");
        const targetZoneId = zones[0].id;
        zones.forEach((zone) => zone.cellKeys.forEach((key) => { plan.cells[key].zoneId = targetZoneId; }));
        sync("API zones merged");
        return success({ zoneId: targetZoneId });
      } catch (error) { return failure(error); }
    },

    getZones() { try { return getZonesInternal(); } catch (error) { return failure(error); } },
    getDashboard() { try { return calculateDashboard(); } catch (error) { return failure(error); } },
    getBounds() { try { return getCellBounds(); } catch (error) { return failure(error); } },
    fitToView() { try { fitAllZonesToView(); return success({ zoom: view.zoom, panX: view.panX, panY: view.panY }); } catch (error) { return failure(error); } },
    exportPngDataUrl() { try { return exportCanvasDataUrl(); } catch (error) { return failure(error); } },

    getBubbleDiagram() { try { return cloneBubbleDiagram(plan.bubbleDiagram); } catch (error) { return failure(error); } },

    setBubbleDiagram(diagram) {
      try {
        const candidate = normalizeBubbleDiagram(diagram);
        requireValidBubbleDiagram(candidate);
        plan.bubbleDiagram = candidate;
        sync("API Bubble Diagram updated");
        return success({ bubbleDiagram: cloneBubbleDiagram(candidate) });
      } catch (error) { return failure(error); }
    },

    addBubble(input) {
      try {
        const bubble = normalizeBubble(input);
        const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
        candidate.bubbles.push(bubble);
        requireValidBubbleDiagram(candidate);
        plan.bubbleDiagram = candidate;
        sync("API Bubble added");
        return success({ bubble: cloneBubbleDiagram({ bubbles: [bubble] }).bubbles[0] });
      } catch (error) { return failure(error); }
    },

    updateBubble(input) {
      try {
        if (!input || typeof input.id !== "string" || !input.id.trim()) throw new Error("Bubble id is required");
        const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
        const index = candidate.bubbles.findIndex((bubble) => bubble.id === input.id);
        if (index < 0) throw new Error(`Unknown Bubble id: ${input.id}`);
        const current = candidate.bubbles[index];
        candidate.bubbles[index] = normalizeBubble({ ...current, ...input });
        requireValidBubbleDiagram(candidate);
        plan.bubbleDiagram = candidate;
        sync("API Bubble updated");
        return success({ bubble: cloneBubbleDiagram({ bubbles: [candidate.bubbles[index]] }).bubbles[0] });
      } catch (error) { return failure(error); }
    },

    removeBubble(bubbleId) {
      try {
        const id = String(bubbleId || "").trim();
        const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
        if (!candidate.bubbles.some((bubble) => bubble.id === id)) throw new Error(`Unknown Bubble id: ${id}`);
        candidate.bubbles = candidate.bubbles.filter((bubble) => bubble.id !== id);
        const removedConnectorIds = candidate.connectors.filter((connector) => connector.fromBubbleId === id || connector.toBubbleId === id).map((connector) => connector.id);
        candidate.connectors = candidate.connectors.filter((connector) => connector.fromBubbleId !== id && connector.toBubbleId !== id);
        plan.bubbleDiagram = candidate;
        sync("API Bubble removed");
        return success({ bubbleId: id, removedConnectorIds });
      } catch (error) { return failure(error); }
    },

    connectBubbles(input) {
      try {
        const connector = normalizeConnector({ ...input, id: input && input.id !== undefined ? input.id : nextDiagramId("connector", plan.bubbleDiagram.connectors) });
        const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
        candidate.connectors.push(connector);
        requireValidBubbleDiagram(candidate);
        plan.bubbleDiagram = candidate;
        sync("API Connector added");
        return success({ connector: cloneBubbleDiagram({ connectors: [connector] }).connectors[0] });
      } catch (error) { return failure(error); }
    },

    updateConnector(input) {
      try {
        if (!input || typeof input.id !== "string" || !input.id.trim()) throw new Error("Connector id is required");
        const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
        const index = candidate.connectors.findIndex((connector) => connector.id === input.id);
        if (index < 0) throw new Error(`Unknown Connector id: ${input.id}`);
        candidate.connectors[index] = normalizeConnector({ ...candidate.connectors[index], ...input });
        requireValidBubbleDiagram(candidate);
        plan.bubbleDiagram = candidate;
        sync("API Connector updated");
        return success({ connector: cloneBubbleDiagram({ connectors: [candidate.connectors[index]] }).connectors[0] });
      } catch (error) { return failure(error); }
    },

    removeConnector(connectorId) {
      try {
        const id = String(connectorId || "").trim();
        if (!plan.bubbleDiagram.connectors.some((connector) => connector.id === id)) throw new Error(`Unknown Connector id: ${id}`);
        plan.bubbleDiagram.connectors = plan.bubbleDiagram.connectors.filter((connector) => connector.id !== id);
        sync("API Connector removed");
        return success({ connectorId: id });
      } catch (error) { return failure(error); }
    },

    validateBubbleDiagram() {
      try {
        const errors = getBubbleDiagramErrors(plan.bubbleDiagram);
        return { ok: errors.length === 0, errors, warnings: [] };
      } catch (error) { return failure(error); }
    },

    createRequirementsSnapshot(input = {}) {
      try {
        requireValidBubbleDiagram(plan.bubbleDiagram);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Snapshot options must be an object");
        if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) throw new Error("Snapshot metadata must be an object");
        const snapshot = {
          requirementsSnapshotId: nextGenerationId("requirements", plan.generation.requirementsSnapshots, "requirementsSnapshotId"),
          version: 1,
          createdAt: new Date().toISOString(),
          metadata: GenerationModel.clone(input.metadata || {}),
          ...GenerationModel.requirementsFromDiagram(plan.bubbleDiagram)
        };
        plan.generation.requirementsSnapshots.push(snapshot);
        sync("Requirements snapshot created");
        return success({ requirementsSnapshot: GenerationModel.clone(snapshot) });
      } catch (error) { return failure(error); }
    },

    listRequirementsSnapshots() {
      try { return GenerationModel.clone(plan.generation.requirementsSnapshots); } catch (error) { return failure(error); }
    },

    getRequirementsSnapshot(id) {
      try { return GenerationModel.clone(findSnapshot(id)); } catch (error) { return failure(error); }
    },

    getGenerationContext(id) {
      try {
        return {
          requirementsSnapshot: GenerationModel.clone(findSnapshot(id)),
          workingBlockPlan: GenerationModel.clone({ moduleSizeMm: plan.moduleSizeMm, categories: plan.categories, cells: plan.cells })
        };
      } catch (error) { return failure(error); }
    },

    getLayoutProblem(id, options = {}) {
      try {
        if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Layout Problem options must be an object");
        const snapshot = findSnapshot(id);
        const frozen = snapshot.metadata && snapshot.metadata.generationContext;
        const generationContext = frozen === undefined
          ? { version: 1, moduleSizeMm: plan.moduleSizeMm, categories: plan.categories }
          : frozen;
        const relevantMemory = window.MemoryModel
          ? window.MemoryModel.relevantMemory({ ...(options.memoryContext || {}), requirementsSnapshotId: id })
          : [];
        return LayoutIntelligence.buildLayoutProblem({
          requirementsSnapshot: snapshot,
          generationContext,
          relevantMemory,
          rulePack: options.rulePack
        });
      } catch (error) { return failure(error); }
    },

    createVariant(input) {
      try {
        const snapshot = findSnapshot(input && input.requirementsSnapshotId);
        const variantId = String(input.variantId || nextGenerationId("variant", plan.generation.variants, "variantId")).trim();
        if (!variantId) throw new Error("variantId is required");
        if (plan.generation.variants.some((item) => item.variantId === variantId)) throw new Error(`Duplicate variantId: ${variantId}`);
        if (input.parentVariantId != null) findVariant(input.parentVariantId);
        const variant = {
          variantId,
          requirementsSnapshotId: snapshot.requirementsSnapshotId,
          parentVariantId: input.parentVariantId || null,
          generationIndex: input.generationIndex === undefined ? nextGenerationIndex() : Number(input.generationIndex),
          strategy: input.strategy === undefined ? "" : String(input.strategy),
          rationale: input.rationale === undefined ? "" : String(input.rationale),
          generator: GenerationModel.clone(input.generator === undefined ? {} : input.generator),
          createdAt: input.createdAt || new Date().toISOString(),
          blockPlan: GenerationModel.normalizeBlockPlan(input.blockPlan, snapshot)
        };
        if (!Number.isInteger(variant.generationIndex) || variant.generationIndex < 0) throw new Error("generationIndex must be a non-negative integer");
        plan.generation.variants.push(variant);
        sync("Variant created");
        return success({ variant: GenerationModel.clone(variant) });
      } catch (error) { return failure(error); }
    },

    createVariants(input) {
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Variant submission must be an object");
        const snapshot = findSnapshot(input.requirementsSnapshotId);
        const parentVariantId = input.parentVariantId == null ? null : String(input.parentVariantId);
        if (parentVariantId !== null) {
          const parent = findVariant(parentVariantId);
          if (parent.requirementsSnapshotId !== snapshot.requirementsSnapshotId) throw new Error("Parent Variant must use the submitted Requirements Snapshot");
        }
        if (!Array.isArray(input.candidates) || !input.candidates.length) throw new Error("candidates must be a non-empty array");

        const stagedState = GenerationModel.normalizeState(plan.generation);
        let generationIndex = nextGenerationIndex();
        const variants = input.candidates.map((candidate, index) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Candidate ${index + 1} must be an object`);
          const allowedCandidateFields = new Set(["strategy", "rationale", "generator", "blockPlan"]);
          Object.keys(candidate).forEach((key) => {
            if (!allowedCandidateFields.has(key)) throw new Error(`Unsupported Candidate ${index + 1} field: ${key}`);
          });
          if (typeof candidate.strategy !== "string" || !candidate.strategy.trim()) throw new Error(`Candidate ${index + 1} strategy is required`);
          if (typeof candidate.rationale !== "string" || !candidate.rationale.trim()) throw new Error(`Candidate ${index + 1} rationale is required`);
          if (candidate.generator !== undefined && (!candidate.generator || typeof candidate.generator !== "object" || Array.isArray(candidate.generator))) {
            throw new Error(`Candidate ${index + 1} generator must be an object`);
          }
          const variantId = nextGenerationId("variant", stagedState.variants, "variantId");
          const variant = {
            variantId,
            requirementsSnapshotId: snapshot.requirementsSnapshotId,
            parentVariantId,
            generationIndex: generationIndex++,
            strategy: candidate.strategy,
            rationale: candidate.rationale,
            generator: GenerationModel.clone(candidate.generator || {}),
            createdAt: new Date().toISOString(),
            blockPlan: requireCompleteGeneratedBlockPlan(candidate.blockPlan, snapshot)
          };
          stagedState.variants.push(variant);
          return variant;
        });
        GenerationModel.requireValidState(stagedState);
        plan.generation = stagedState;
        sync(`${variants.length} variants ready`);
        return success({ variants: GenerationModel.clone(variants) });
      } catch (error) { return failure(error); }
    },

    listVariants() {
      try { return GenerationModel.clone(plan.generation.variants); } catch (error) { return failure(error); }
    },

    getVariant(id) {
      try { return GenerationModel.clone(findVariant(id)); } catch (error) { return failure(error); }
    },

    activateVariant(id) {
      try {
        GenerationModel.requireValidState(plan.generation);
        const variant = findVariant(id);
        if (typeof pushUndoState === "function") pushUndoState();
        plan.moduleSizeMm = variant.blockPlan.moduleSizeMm;
        plan.categories = GenerationModel.clone(variant.blockPlan.categories);
        plan.cells = GenerationModel.clone(variant.blockPlan.cells);
        activeCategoryId = plan.categories[0] ? plan.categories[0].id : "unassigned";
        sync("Variant activated");
        return success({ variantId: variant.variantId, plan: serializePlanForSave() });
      } catch (error) { return failure(error); }
    },

    duplicateVariant(input) {
      try {
        const source = findVariant(input && (input.sourceVariantId || input.variantId));
        return api.createVariant({
          ...GenerationModel.clone(source),
          ...GenerationModel.clone(input),
          variantId: input.newVariantId,
          parentVariantId: source.variantId,
          generationIndex: input.generationIndex,
          blockPlan: GenerationModel.clone(source.blockPlan),
          createdAt: undefined
        });
      } catch (error) { return failure(error); }
    },

    deleteVariant(id) {
      try {
        const variant = findVariant(id);
        if (plan.generation.variants.some((item) => item.parentVariantId === variant.variantId)) {
          throw new Error(`Cannot delete Variant with children: ${variant.variantId}`);
        }
        if (plan.review.reviews.some((review) => review.variantId === variant.variantId || review.preferredOverVariantId === variant.variantId)) {
          throw new Error(`Cannot delete Variant referenced by Review history: ${variant.variantId}`);
        }
        plan.generation.variants = plan.generation.variants.filter((item) => item.variantId !== variant.variantId);
        sync("Variant deleted");
        return success({ variantId: variant.variantId });
      } catch (error) { return failure(error); }
    },

    validateVariantAgainstDiagram(id) {
      try {
        const variant = findVariant(id);
        const snapshot = findSnapshot(variant.requirementsSnapshotId);
        return GenerationModel.clone(GenerationModel.validate(variant, snapshot));
      } catch (error) { return failure(error); }
    },

    evaluateVariantLayout(id, options = {}) {
      try {
        if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Variant evaluation options must be an object");
        const variant = findVariant(id);
        const snapshot = findSnapshot(variant.requirementsSnapshotId);
        const frozen = snapshot.metadata && snapshot.metadata.generationContext;
        const rulePack = options.rulePack === undefined && frozen ? frozen.rulePack : options.rulePack;
        return LayoutIntelligence.evaluateVariant(variant, snapshot, { rulePack });
      } catch (error) { return failure(error); }
    },

    createReview(input) {
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review input must be an object");
        const variant = findVariant(input.variantId);
        if (!["accept", "iterate", "reject"].includes(input.decision)) throw new Error("decision must be accept, iterate, or reject");
        const reviewId = String(input.reviewId || nextGenerationId("review", plan.review.reviews, "reviewId")).trim();
        if (!reviewId) throw new Error("reviewId is required");
        if (plan.review.reviews.some((item) => item.reviewId === reviewId)) throw new Error(`Duplicate reviewId: ${reviewId}`);
        const preferredId = input.preferredOverVariantId == null || input.preferredOverVariantId === "" ? null : String(input.preferredOverVariantId);
        if (preferredId !== null) {
          const preferred = findVariant(preferredId);
          if (preferred.variantId === variant.variantId) throw new Error("A Variant cannot be preferred over itself");
          if (preferred.requirementsSnapshotId !== variant.requirementsSnapshotId) throw new Error("Preferred Variant must use the same Requirements Snapshot");
        }
        const review = {
          reviewId,
          variantId: variant.variantId,
          requirementsSnapshotId: variant.requirementsSnapshotId,
          decision: input.decision,
          good: ReviewModel.textItems(input.good),
          problems: ReviewModel.textItems(input.problems),
          nextInstructions: ReviewModel.textItems(input.nextInstructions),
          preferredOverVariantId: preferredId,
          createdAt: input.createdAt || new Date().toISOString()
        };
        ReviewModel.requireValidState({ version: 1, reviews: [...plan.review.reviews, review] }, plan.generation);
        plan.review.reviews.push(review);
        sync("Review saved");
        return success({ review: ReviewModel.clone(review) });
      } catch (error) { return failure(error); }
    },

    listReviews(filter = {}) {
      try {
        if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("Review filter must be an object");
        return ReviewModel.clone(plan.review.reviews.filter((review) =>
          (filter.variantId === undefined || review.variantId === filter.variantId) &&
          (filter.requirementsSnapshotId === undefined || review.requirementsSnapshotId === filter.requirementsSnapshotId) &&
          (filter.decision === undefined || review.decision === filter.decision)));
      } catch (error) { return failure(error); }
    },

    getReview(id) {
      try { return ReviewModel.clone(findReview(id)); } catch (error) { return failure(error); }
    },

    getVariantReviews(id) {
      try {
        findVariant(id);
        return ReviewModel.clone(plan.review.reviews.filter((review) => review.variantId === id));
      } catch (error) { return failure(error); }
    },

    getIterationContext(id) {
      try {
        const variant = findVariant(id);
        const lineage = [];
        const seen = new Set();
        let cursor = variant;
        while (cursor) {
          if (seen.has(cursor.variantId)) throw new Error("Variant lineage contains a cycle");
          seen.add(cursor.variantId);
          lineage.unshift(cursor);
          cursor = cursor.parentVariantId === null ? null : findVariant(cursor.parentVariantId);
        }
        const lineageIds = new Set(lineage.map((item) => item.variantId));
        const reviews = plan.review.reviews.filter((review) => lineageIds.has(review.variantId))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.reviewId.localeCompare(b.reviewId));
        return ReviewModel.clone({
          requirementsSnapshot: findSnapshot(variant.requirementsSnapshotId),
          variant,
          validation: GenerationModel.validate(variant, findSnapshot(variant.requirementsSnapshotId)),
          lineage,
          reviews,
          nextChildDefaults: { parentVariantId: variant.variantId, requirementsSnapshotId: variant.requirementsSnapshotId }
        });
      } catch (error) { return failure(error); }
    },

    validatePlan() {
      try {
        const errors = [];
        const warnings = [];
        const categoryIds = new Set(plan.categories.map((category) => category.id));
        Object.entries(plan.cells).forEach(([key, cell]) => {
          if (!/^-?\d+,-?\d+$/.test(key)) errors.push(`Invalid cell key: ${key}`);
          if (!categoryIds.has(cell.categoryId)) errors.push(`Cell ${key} has unknown categoryId: ${cell.categoryId}`);
          if (!cell.zoneId) warnings.push(`Cell ${key} has no zoneId`);
        });
        return { ok: errors.length === 0, errors, warnings, dashboard: calculateDashboard(), bounds: getCellBounds(), zoneCount: calculateZones().length, cellCount: Object.keys(plan.cells).length };
      } catch (error) { return failure(error); }
    },

    getStateSummary() {
      try {
        return { moduleSizeMm: plan.moduleSizeMm, categories: plan.categories.map((category) => ({ ...category })), dashboard: calculateDashboard(), bounds: getCellBounds(), zones: getZonesInternal() };
      } catch (error) { return failure(error); }
    }
  };

  window.BlockPlanAPI = api;
})();
