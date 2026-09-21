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

  function normalizeVariantBlockPlan(input, snapshot) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("blockPlan is required");
    const moduleSizeMm = Number(input.moduleSizeMm);
    if (!Number.isFinite(moduleSizeMm) || moduleSizeMm <= 0) throw new Error("blockPlan.moduleSizeMm must be a positive number");
    if (!Array.isArray(input.categories) || !input.categories.length) throw new Error("blockPlan.categories must be a non-empty array");
    const categories = GenerationModel.clone(input.categories);
    const categoryIds = new Set(categories.map((category) => category.id));
    const cells = GenerationModel.clone(input.cells || {});
    Object.entries(cells).forEach(([key, cell]) => {
      if (!/^-?\d+,-?\d+$/.test(key)) throw new Error(`Invalid cell key: ${key}`);
      if (!cell || !categoryIds.has(cell.categoryId)) throw new Error(`Cell ${key} has unknown categoryId`);
      if (typeof cell.zoneId !== "string" || !cell.zoneId.trim()) throw new Error(`Cell ${key} must have a zoneId`);
    });
    const zoneAssignments = GenerationModel.clone(input.zoneAssignments || {});
    const zoneIds = new Set(GenerationModel.zonesFor(cells).keys());
    const bubbleIds = new Set(snapshot.bubbles.map((bubble) => bubble.id));
    Object.entries(zoneAssignments).forEach(([zoneId, assignment]) => {
      if (!zoneIds.has(zoneId)) throw new Error(`Unknown Zone id: ${zoneId}`);
      if (!assignment || !bubbleIds.has(assignment.bubbleId)) throw new Error(`Unknown Bubble id: ${assignment && assignment.bubbleId}`);
    });
    return { moduleSizeMm, categories, cells, zoneAssignments };
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
          generationIndex: input.generationIndex === undefined ? plan.generation.variants.length + 1 : Number(input.generationIndex),
          strategy: input.strategy === undefined ? "" : String(input.strategy),
          rationale: input.rationale === undefined ? "" : String(input.rationale),
          generator: GenerationModel.clone(input.generator === undefined ? {} : input.generator),
          createdAt: input.createdAt || new Date().toISOString(),
          blockPlan: normalizeVariantBlockPlan(input.blockPlan, snapshot)
        };
        if (!Number.isInteger(variant.generationIndex) || variant.generationIndex < 0) throw new Error("generationIndex must be a non-negative integer");
        plan.generation.variants.push(variant);
        sync("Variant created");
        return success({ variant: GenerationModel.clone(variant) });
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
          blockPlan: GenerationModel.clone(source.blockPlan),
          createdAt: undefined
        });
      } catch (error) { return failure(error); }
    },

    deleteVariant(id) {
      try {
        const variant = findVariant(id);
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
