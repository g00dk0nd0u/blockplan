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

  const api = {
    version: 1,

    getPlan() {
      try { return serializePlanForSave(); } catch (error) { return failure(error); }
    },

    setPlan(planJson) {
      try {
        plan = normalizePlan(typeof planJson === "string" ? JSON.parse(planJson) : planJson);
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
        const copyId = newZoneId ? String(newZoneId) : createZoneId();
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
