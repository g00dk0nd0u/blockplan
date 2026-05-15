"use strict";

const STORAGE_KEY = "blockplan.currentPlan.v1";
const CELL_PX = 36;
const CANVAS_BACKGROUND = "#E8E5E0";
const GRID_DOT = "rgba(126, 116, 104, 0.36)";
const GRID_DOT_SOFT = "rgba(126, 116, 104, 0.22)";
const TOOLS = ["select", "paint", "copy", "cut", "erase", "merge"];

const categories = [
  { id: "unassigned", name: "Unassigned", color: "#B8B4AE" },
  { id: "office", name: "Office", color: "#AABB9C" },
  { id: "meeting", name: "Meeting", color: "#90B0C4" },
  { id: "core", name: "Core", color: "#C0A090" },
  { id: "circulation", name: "Circulation", color: "#D2C890" },
  { id: "mep", name: "MEP", color: "#A89EB8" }
];
const defaultCategoryColors = new Map(categories.map((category) => [category.id, category.color]));

const defaultPlan = {
  version: 1,
  moduleSizeMm: 3600,
  categories,
  cells: {}
};

let plan = clonePlan(defaultPlan);
let activeCategoryId = "office";
let isPainting = false;
let isPanning = false;
let isSpaceDown = false;
let lastPointer = { x: 0, y: 0 };
let editingCategoryId = null;
let editingCategoryFallback = "";
let activeTool = "select";
let selectedZoneSignature = null;
let transformDraft = null;
let paintStrokeZoneId = null;
let cutDraft = null;

const view = {
  zoom: 1,
  panX: 0,
  panY: 0
};

const canvas = document.getElementById("planningCanvas");
const ctx = canvas.getContext("2d");
const categoryList = document.getElementById("categoryList");
const dashboard = document.getElementById("dashboard");
const moduleSizeSelect = document.getElementById("moduleSize");
const cellAreaReadout = document.getElementById("cellAreaReadout");
const saveStatus = document.getElementById("saveStatus");
const zoomStatus = document.getElementById("zoomStatus");
const cellStatus = document.getElementById("cellStatus");
const loadJsonInput = document.getElementById("loadJsonInput");

function clonePlan(source) {
  return {
    version: source.version || 1,
    moduleSizeMm: Number(source.moduleSizeMm) || 3600,
    categories: source.categories ? source.categories.map((item) => ({ ...item })) : categories,
    cells: source.cells
      ? Object.fromEntries(Object.entries(source.cells).map(([key, cell]) => [key, { ...cell }]))
      : {}
  };
}

function categoryById(categoryId) {
  return plan.categories.find((category) => category.id === categoryId) || plan.categories[0];
}

function setup() {
  restorePlan();
  renderCategoryList();
  renderToolButtons();
  bindEvents();
  resizeCanvas();
  updateUi();
  draw();
}

function bindEvents() {
  window.addEventListener("resize", () => {
    resizeCanvas();
    draw();
  });

  moduleSizeSelect.addEventListener("change", () => {
    plan.moduleSizeMm = Number(moduleSizeSelect.value);
    persistPlan();
    updateUi();
  });

  document.getElementById("saveJsonButton").addEventListener("click", saveJson);
  document.getElementById("loadJsonButton").addEventListener("click", () => loadJsonInput.click());
  document.getElementById("exportPngButton").addEventListener("click", exportPng);
  document.getElementById("clearButton").addEventListener("click", clearPlan);
  document.getElementById("rotateToolButton").addEventListener("click", rotateSelectedZone);
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveTool(button.dataset.tool);
    });
  });
  loadJsonInput.addEventListener("change", loadJson);

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointerAction);
  canvas.addEventListener("pointercancel", endPointerAction);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (isEditingText()) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      isSpaceDown = true;
      return;
    }

    if (event.key === "Escape") {
      cancelCurrentOperation();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelectedZone();
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "v") {
      setActiveTool("select");
    } else if (key === "b") {
      setActiveTool("paint");
    } else if (key === "m") {
      setActiveTool("select");
    } else if (key === "c") {
      setActiveTool("copy");
    } else if (key === "x") {
      setActiveTool("cut");
    } else if (key === "r") {
      rotateSelectedZone();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      isSpaceDown = false;
      if (!isPanning) {
        canvas.classList.remove("is-panning");
        updateCanvasCursor();
      }
    }
  });
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

function renderCategoryList() {
  if (!categoryList) return;

  categoryList.innerHTML = "";
  plan.categories.forEach((category) => {
    const row = document.createElement("div");
    row.className = "category-button";
    row.dataset.categoryId = category.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Select ${category.name}`);

    const swatch = document.createElement("span");
    swatch.className = "category-swatch";
    swatch.style.background = category.color;
    row.appendChild(swatch);

    if (editingCategoryId === category.id) {
      const input = document.createElement("input");
      input.className = "category-name-input";
      input.value = category.name;
      input.setAttribute("aria-label", `Rename ${category.name}`);
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("input", () => renameCategory(category.id, input.value));
      input.addEventListener("blur", finishCategoryRename);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          input.blur();
        }
        if (event.key === "Escape") {
          renameCategory(category.id, editingCategoryFallback);
          input.blur();
        }
      });
      row.appendChild(input);
      window.setTimeout(() => {
        input.focus();
        input.select();
      });
    } else {
      const name = document.createElement("span");
      name.className = "category-name";
      name.textContent = category.name;
      name.title = "Click to rename";
      name.addEventListener("click", (event) => {
        event.stopPropagation();
        startCategoryRename(category.id);
      });
      row.appendChild(name);
    }

    row.addEventListener("click", () => {
      activeCategoryId = category.id;
      setActiveTool("paint");
      renderCategoryList();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activeCategoryId = category.id;
        setActiveTool("paint");
        renderCategoryList();
      }
    });

    if (category.id === activeCategoryId) {
      row.classList.add("is-active");
    }
    if (category.id === "unassigned") {
      row.classList.add("is-unassigned");
    }
    categoryList.appendChild(row);
  });
}

function startCategoryRename(categoryId) {
  const category = categoryById(categoryId);
  editingCategoryId = categoryId;
  editingCategoryFallback = category.name;
  activeCategoryId = categoryId;
  setActiveTool("paint");
  renderCategoryList();
  renderDashboard();
}

function renameCategory(categoryId, rawName) {
  const category = categoryById(categoryId);
  const nextName = rawName.trim();
  category.name = nextName || editingCategoryFallback || category.name;
  persistPlan();
  renderDashboard();
}

function finishCategoryRename() {
  editingCategoryId = null;
  editingCategoryFallback = "";
  renderCategoryList();
  renderDashboard();
}

function renderToolButtons() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === activeTool);
  });
}

function setActiveTool(tool) {
  if (!TOOLS.includes(tool)) {
    return;
  }
  activeTool = tool;
  transformDraft = null;
  renderToolButtons();
  updateCanvasCursor();
}

function updateCanvasCursor() {
  if (activeTool === "paint") {
    canvas.style.cursor = "crosshair";
  } else if (activeTool === "merge") {
    canvas.style.cursor = "alias";
  } else if (activeTool === "cut") {
    canvas.style.cursor = "cell";
  } else if (activeTool === "erase") {
    canvas.style.cursor = "not-allowed";
  } else if (activeTool === "select" || activeTool === "copy") {
    canvas.style.cursor = "grab";
  } else {
    canvas.style.cursor = "default";
  }
}

function cancelCurrentOperation() {
  transformDraft = null;
  cutDraft = null;
  paintStrokeZoneId = null;
  selectedZoneSignature = null;
  draw();
}

function isEditingText() {
  const active = document.activeElement;
  return active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
}

function onPointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  lastPointer = { x: event.clientX, y: event.clientY };
  const shouldPan = event.button === 1 || isSpaceDown;

  if (shouldPan) {
    isPanning = true;
    canvas.classList.add("is-panning");
    canvas.style.cursor = "grabbing";
    return;
  }

  if (event.button !== 0) {
    return;
  }

  if (activeTool === "cut") {
    startCutAtEvent(event);
    return;
  }

  if (activeTool !== "paint") {
    handleZoneToolPointerDown(event);
    return;
  }

  isPainting = true;
  paintStrokeZoneId = createZoneId();
  paintAtEvent(event);
}

function onPointerMove(event) {
  updateCellStatus(event);

  if (isPanning) {
    view.panX += event.clientX - lastPointer.x;
    view.panY += event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };
    draw();
    return;
  }

  if (isPainting) {
    paintAtEvent(event);
  }

  if (cutDraft) {
    cutAtEvent(event);
  }

  if (transformDraft) {
    updateTransformDraft(event);
  }
}

function endPointerAction(event) {
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (isPainting) {
    paintStrokeZoneId = null;
    persistPlan();
    updateUi();
  }

  if (cutDraft) {
    finishCut();
  }

  if (transformDraft) {
    commitTransformDraft();
  }

  isPainting = false;
  isPanning = false;
  if (!isSpaceDown) {
    canvas.classList.remove("is-panning");
    updateCanvasCursor();
  }
}

function onWheel(event) {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const before = screenToWorld(mouseX, mouseY);
  const zoomFactor = event.deltaY < 0 ? 1.12 : 0.88;
  view.zoom = clamp(view.zoom * zoomFactor, 0.25, 4);
  view.panX = mouseX - before.x * view.zoom;
  view.panY = mouseY - before.y * view.zoom;
  draw();
  updateZoomStatus();
}

function paintAtEvent(event) {
  const cell = eventToCell(event);
  const key = cellKey(cell.x, cell.y);
  const existing = plan.cells[key];

  if (existing && existing.categoryId === activeCategoryId) {
    return;
  }

  plan.cells[key] = { categoryId: activeCategoryId, zoneId: paintStrokeZoneId || createZoneId() };
  draw();
  updateUi();
}

function startCutAtEvent(event) {
  const cell = eventToCell(event);
  const zone = findZoneAtCell(cell.x, cell.y);

  if (!zone) {
    selectedZoneSignature = null;
    cutDraft = null;
    draw();
    return;
  }

  selectedZoneSignature = zone.signature;
  cutDraft = {
    sourceZoneId: zone.id,
    newZoneId: createZoneId(),
    categoryId: zone.categoryId,
    touchedKeys: new Set()
  };
  cutAtEvent(event);
}

function cutAtEvent(event) {
  if (!cutDraft) {
    return;
  }

  const cell = eventToCell(event);
  const key = cellKey(cell.x, cell.y);
  const existing = plan.cells[key];
  if (!existing || existing.zoneId !== cutDraft.sourceZoneId) {
    return;
  }

  existing.zoneId = cutDraft.newZoneId;
  cutDraft.touchedKeys.add(key);
  selectedZoneSignature = zoneSignature(cutDraft.newZoneId);
  draw();
  updateUi();
}

function finishCut() {
  const draft = cutDraft;
  cutDraft = null;

  if (!draft.touchedKeys.size) {
    draw();
    return;
  }

  splitZoneIntoConnectedComponents(draft.sourceZoneId);
  splitZoneIntoConnectedComponents(draft.newZoneId);
  selectedZoneSignature = zoneSignature(draft.newZoneId);
  persistPlan();
  updateUi();
}

function handleZoneToolPointerDown(event) {
  const cell = eventToCell(event);
  const zone = findZoneAtCell(cell.x, cell.y);

  if (!zone) {
    selectedZoneSignature = null;
    transformDraft = null;
    draw();
    return;
  }

  selectedZoneSignature = zone.signature;

  if (activeTool === "select" || activeTool === "copy") {
    transformDraft = {
      mode: activeTool === "copy" ? "copy" : "move",
      categoryId: zone.categoryId,
      zoneId: zone.id,
      originalKeys: [...zone.cellKeys],
      startCell: cell,
      dx: 0,
      dy: 0,
      isValid: true
    };
  }

  draw();
}

function updateTransformDraft(event) {
  const cell = eventToCell(event);
  transformDraft.dx = cell.x - transformDraft.startCell.x;
  transformDraft.dy = cell.y - transformDraft.startCell.y;
  const destinationKeys = offsetCellKeys(transformDraft.originalKeys, transformDraft.dx, transformDraft.dy);
  transformDraft.isValid = canPlaceCellKeys(
    destinationKeys,
    transformDraft.mode === "move" ? new Set(transformDraft.originalKeys) : new Set()
  );
  draw();
}

function commitTransformDraft() {
  const draft = transformDraft;
  transformDraft = null;

  if (!draft.dx && !draft.dy) {
    draw();
    return;
  }

  const destinationKeys = offsetCellKeys(draft.originalKeys, draft.dx, draft.dy);
  const ignoreKeys = draft.mode === "move" ? new Set(draft.originalKeys) : new Set();
  if (!canPlaceCellKeys(destinationKeys, ignoreKeys)) {
    showSaveStatus("Overlap blocked");
    draw();
    return;
  }

  if (draft.mode === "move") {
    draft.originalKeys.forEach((key) => delete plan.cells[key]);
  }
  const destinationZoneId = draft.mode === "copy" ? createZoneId() : draft.zoneId;
  destinationKeys.forEach((key) => {
    plan.cells[key] = { categoryId: draft.categoryId, zoneId: destinationZoneId };
  });

  selectedZoneSignature = zoneSignature(destinationZoneId);
  persistPlan();
  updateUi();
}

function eventToCell(event) {
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  return {
    x: Math.floor(world.x / CELL_PX),
    y: Math.floor(world.y / CELL_PX)
  };
}

function screenToWorld(screenX, screenY) {
  return {
    x: (screenX - view.panX) / view.zoom,
    y: (screenY - view.panY) / view.zoom
  };
}

function updateCellStatus(event) {
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const x = Math.floor(world.x / CELL_PX);
  const y = Math.floor(world.y / CELL_PX);
  cellStatus.textContent = `Cell ${x}, ${y}`;
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackground(rect);
  drawGrid(rect);
  drawZones();
  updateZoomStatus();
}

function drawBackground(rect) {
  ctx.fillStyle = CANVAS_BACKGROUND;
  ctx.fillRect(0, 0, rect.width, rect.height);
}

function drawZones() {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  drawZonesOnContext(ctx, calculateZones(), { showSelection: true, labelZoom: view.zoom });
  drawTransformDraft(ctx);
  ctx.restore();
}

function drawZonesOnContext(targetCtx, zones, options = {}) {
  const labelItems = [];

  zones.forEach((zone) => {
    const category = categoryById(zone.categoryId);
    const isUnassigned = zone.categoryId === "unassigned";
    const loops = buildZoneBoundaryLoops(zone.cellKeys);

    if (!loops.length) {
      return;
    }

    targetCtx.save();
    targetCtx.beginPath();
    loops.forEach((loop) => addRoundedLoopToPath(targetCtx, loop));

    targetCtx.fillStyle = category.color;
    targetCtx.globalAlpha = isUnassigned ? 0.25 : 0.71;
    targetCtx.fill("evenodd");

    targetCtx.globalAlpha = 1;
    targetCtx.strokeStyle = isUnassigned ? "rgba(110, 104, 96, 0.42)" : darkenColor(category.color, 0.22);
    targetCtx.lineWidth = isUnassigned ? 1 : 1.35;
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    targetCtx.stroke();

    if (options.showSelection && zone.signature === selectedZoneSignature) {
      targetCtx.globalAlpha = 1;
      targetCtx.strokeStyle = "#1C1B19";
      targetCtx.lineWidth = 2.1;
      targetCtx.setLineDash([6, 5]);
      targetCtx.stroke();
      targetCtx.setLineDash([]);
    }

    labelItems.push({ zone, category });
    targetCtx.restore();
  });

  labelItems.forEach(({ zone, category }) => {
    drawZoneLabel(targetCtx, zone, category, options);
  });
}

function drawTransformDraft(targetCtx) {
  if (!transformDraft || (!transformDraft.dx && !transformDraft.dy)) {
    return;
  }

  const destinationKeys = offsetCellKeys(transformDraft.originalKeys, transformDraft.dx, transformDraft.dy);
  const category = categoryById(transformDraft.categoryId);
  const loops = buildZoneBoundaryLoops(destinationKeys);

  targetCtx.save();
  targetCtx.beginPath();
  loops.forEach((loop) => addRoundedLoopToPath(targetCtx, loop));
  targetCtx.fillStyle = category.color;
  targetCtx.globalAlpha = transformDraft.isValid ? 0.38 : 0.16;
  targetCtx.fill("evenodd");
  targetCtx.globalAlpha = 1;
  targetCtx.strokeStyle = transformDraft.isValid ? "#1C1B19" : "#B04040";
  targetCtx.lineWidth = 3;
  targetCtx.setLineDash([7, 5]);
  targetCtx.stroke();
  targetCtx.setLineDash([]);
  targetCtx.restore();
}

function drawZoneLabel(targetCtx, zone, category, options = {}) {
  const zoom = options.labelZoom || 1;
  const cellCount = zone.cellKeys.length;
  const screenArea = cellCount * CELL_PX * CELL_PX * zoom * zoom;
  if (zoom < 0.52 || cellCount < 2 || screenArea < 4200) {
    return;
  }

  const bounds = getBoundsForKeys(zone.cellKeys);
  const maxWidth = Math.max(0, bounds.width * CELL_PX - 12 / zoom);
  if (maxWidth < 42 / zoom) {
    return;
  }

  const anchor = getZoneLabelAnchor(zone.cellKeys);
  const areaText = `${(cellCount * getCellAreaSqm()).toFixed(1)} ㎡`;
  const fontSize = clamp(12 / zoom, 3, 12);
  const lineHeight = fontSize * 1.2;

  targetCtx.save();
  targetCtx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const categoryWidth = targetCtx.measureText(category.name).width;
  targetCtx.font = `500 ${fontSize * 0.92}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const areaWidth = targetCtx.measureText(areaText).width;
  if (Math.max(categoryWidth, areaWidth) > maxWidth) {
    targetCtx.restore();
    return;
  }

  targetCtx.textAlign = "center";
  targetCtx.textBaseline = "middle";
  targetCtx.fillStyle = "rgba(42, 39, 35, 0.72)";
  targetCtx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  targetCtx.fillText(category.name, anchor.x, anchor.y - lineHeight * 0.48);
  targetCtx.fillStyle = "rgba(42, 39, 35, 0.58)";
  targetCtx.font = `500 ${fontSize * 0.92}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  targetCtx.fillText(areaText, anchor.x, anchor.y + lineHeight * 0.58);
  targetCtx.restore();
}

function getZoneLabelAnchor(cellKeys) {
  const centers = cellKeys.map((key) => {
    const [x, y] = parseCellKey(key);
    return { x: (x + 0.5) * CELL_PX, y: (y + 0.5) * CELL_PX };
  });
  const centroid = centers.reduce(
    (total, center) => ({ x: total.x + center.x, y: total.y + center.y }),
    { x: 0, y: 0 }
  );
  centroid.x /= centers.length;
  centroid.y /= centers.length;

  return centers.reduce((nearest, center) => {
    return distance(center, centroid) < distance(nearest, centroid) ? center : nearest;
  }, centers[0]);
}

function buildZoneBoundaryLoops(cellKeys) {
  const cellSet = new Set(cellKeys);
  const edges = [];

  cellKeys.forEach((key) => {
    const [x, y] = parseCellKey(key);
    if (!cellSet.has(cellKey(x, y - 1))) {
      edges.push(createBoundaryEdge(x, y, x + 1, y, 0));
    }
    if (!cellSet.has(cellKey(x + 1, y))) {
      edges.push(createBoundaryEdge(x + 1, y, x + 1, y + 1, 1));
    }
    if (!cellSet.has(cellKey(x, y + 1))) {
      edges.push(createBoundaryEdge(x + 1, y + 1, x, y + 1, 2));
    }
    if (!cellSet.has(cellKey(x - 1, y))) {
      edges.push(createBoundaryEdge(x, y + 1, x, y, 3));
    }
  });

  return orderBoundaryLoops(edges);
}

function createBoundaryEdge(startX, startY, endX, endY, dir) {
  return {
    id: `${startX},${startY}>${endX},${endY}`,
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
    dir
  };
}

function orderBoundaryLoops(edges) {
  const edgesByStart = new Map();
  const unused = new Set(edges.map((edge) => edge.id));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const loops = [];

  edges.forEach((edge) => {
    const key = pointKey(edge.start);
    if (!edgesByStart.has(key)) {
      edgesByStart.set(key, []);
    }
    edgesByStart.get(key).push(edge);
  });

  edges.forEach((edge) => {
    if (!unused.has(edge.id)) {
      return;
    }

    const loop = [edge.start];
    let current = edge;
    let guard = 0;

    while (current && unused.has(current.id) && guard < edges.length + 4) {
      unused.delete(current.id);
      loop.push(current.end);

      if (pointKey(current.end) === pointKey(loop[0])) {
        break;
      }

      const next = chooseNextBoundaryEdge(current, edgesByStart.get(pointKey(current.end)) || [], unused);
      current = next ? edgeById.get(next.id) : null;
      guard += 1;
    }

    const cleanLoop = simplifyBoundaryLoop(loop);
    if (cleanLoop.length >= 4) {
      loops.push(cleanLoop);
    }
  });

  return loops;
}

function chooseNextBoundaryEdge(current, candidates, unused) {
  const available = candidates.filter((edge) => unused.has(edge.id));
  if (!available.length) {
    return null;
  }

  const turnPreference = [1, 0, 3, 2];
  return available.sort((a, b) => {
    const aTurn = (a.dir - current.dir + 4) % 4;
    const bTurn = (b.dir - current.dir + 4) % 4;
    return turnPreference.indexOf(aTurn) - turnPreference.indexOf(bTurn);
  })[0];
}

function simplifyBoundaryLoop(loop) {
  const openLoop = loop.slice(0, -1);
  const simplified = openLoop.filter((point, index) => {
    const previous = openLoop[(index - 1 + openLoop.length) % openLoop.length];
    const next = openLoop[(index + 1) % openLoop.length];
    const sameX = previous.x === point.x && point.x === next.x;
    const sameY = previous.y === point.y && point.y === next.y;
    return !sameX && !sameY;
  });
  return simplified;
}

function addRoundedLoopToPath(targetCtx, loop) {
  const points = loop.map((point) => ({
    x: point.x * CELL_PX,
    y: point.y * CELL_PX
  }));
  const radius = CELL_PX * 0.22;

  points.forEach((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const previousDistance = distance(point, previous);
    const nextDistance = distance(point, next);
    const cornerRadius = Math.min(radius, previousDistance / 2 - 0.01, nextDistance / 2 - 0.01);
    const start = pointAlong(point, previous, cornerRadius);
    const end = pointAlong(point, next, cornerRadius);

    if (index === 0) {
      targetCtx.moveTo(start.x, start.y);
    } else {
      targetCtx.lineTo(start.x, start.y);
    }
    targetCtx.quadraticCurveTo(point.x, point.y, end.x, end.y);
  });
  targetCtx.closePath();
}

function pointAlong(from, to, distancePx) {
  const total = distance(from, to);
  if (!total) {
    return { ...from };
  }
  const ratio = distancePx / total;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointKey(point) {
  return `${point.x},${point.y}`;
}

function drawGrid(rect) {
  const spacing = CELL_PX * view.zoom;
  if (spacing < 7) {
    return;
  }

  const startX = view.panX % spacing;
  const startY = view.panY % spacing;
  const radius = clamp(spacing * 0.035, 0.7, 1.8);
  ctx.fillStyle = spacing < 18 ? GRID_DOT_SOFT : GRID_DOT;

  for (let x = startX; x < rect.width; x += spacing) {
    for (let y = startY; y < rect.height; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function updateUi() {
  moduleSizeSelect.value = String(plan.moduleSizeMm);
  cellAreaReadout.textContent = `${getCellAreaSqm().toFixed(2)} ㎡`;
  renderDashboard();
  draw();
}

function renderDashboard() {
  const stats = calculateDashboard();
  const table = document.createElement("table");
  table.className = "dashboard-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>色</th>
        <th>Category</th>
        <th class="number-cell">Area ㎡</th>
        <th class="number-cell">Zones</th>
        <th class="number-cell">Cells</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  plan.categories.forEach((category) => {
    const categoryStats = stats[category.id] || { cellCount: 0, zoneCount: 0, areaSqm: 0 };
    const row = document.createElement("tr");
    row.className = "dashboard-category-row";
    row.dataset.categoryId = category.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Use ${category.name}`);

    if (category.id === activeCategoryId) {
      row.classList.add("is-active");
    }
    if (category.id === "unassigned") {
      row.classList.add("is-unassigned");
    }

    const swatchCell = document.createElement("td");
    swatchCell.className = "dashboard-color-cell";
    const swatch = document.createElement("span");
    swatch.className = "dashboard-color-swatch";
    swatch.style.background = category.color;
    swatchCell.appendChild(swatch);

    const nameCell = document.createElement("td");
    nameCell.className = "dashboard-category";

    if (editingCategoryId === category.id) {
      const input = document.createElement("input");
      input.className = "category-name-input";
      input.value = category.name;
      input.setAttribute("aria-label", `Rename ${category.name}`);
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("input", () => renameCategory(category.id, input.value));
      input.addEventListener("blur", finishCategoryRename);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          input.blur();
        }
        if (event.key === "Escape") {
          renameCategory(category.id, editingCategoryFallback);
          input.blur();
        }
      });
      nameCell.appendChild(input);
      window.setTimeout(() => {
        input.focus();
        input.select();
      });
    } else {
      const name = document.createElement("span");
      name.className = "dashboard-category-label category-name";
      name.textContent = category.name;
      name.title = "Click to rename";
      name.addEventListener("click", (event) => {
        event.stopPropagation();
        startCategoryRename(category.id);
      });
      nameCell.appendChild(name);
    }

    const areaCell = document.createElement("td");
    areaCell.className = "number-cell";
    areaCell.textContent = categoryStats.areaSqm.toFixed(2);

    const zoneCell = document.createElement("td");
    zoneCell.className = "number-cell";
    zoneCell.textContent = String(categoryStats.zoneCount);

    const countCell = document.createElement("td");
    countCell.className = "number-cell";
    countCell.textContent = String(categoryStats.cellCount);

    row.appendChild(swatchCell);
    row.appendChild(nameCell);
    row.appendChild(areaCell);
    row.appendChild(zoneCell);
    row.appendChild(countCell);

    row.addEventListener("click", () => {
      const selectedZoneIds =
        typeof getSelectedZoneIdsForReassign === "function" ? getSelectedZoneIdsForReassign() : new Set();

      if (selectedZoneIds.size && typeof reassignSelectedZones === "function") {
        reassignSelectedZones(category.id, selectedZoneIds);
        return;
      }

      activeCategoryId = category.id;
      setActiveTool("paint");
      renderCategoryList();
      renderDashboard();
      draw();
    });

    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      if (event.target.closest(".category-name-input")) {
        return;
      }

      event.preventDefault();
      row.click();
    });

    tbody.appendChild(row);
  });

  dashboard.innerHTML = "";
  dashboard.appendChild(table);
}

function calculateDashboard() {
  const stats = {};
  plan.categories.forEach((category) => {
    stats[category.id] = { cellCount: 0, zoneCount: 0, areaSqm: 0 };
  });

  Object.values(plan.cells).forEach((cell) => {
    if (!stats[cell.categoryId]) {
      stats[cell.categoryId] = { cellCount: 0, zoneCount: 0, areaSqm: 0 };
    }
    stats[cell.categoryId].cellCount += 1;
  });

  const zones = calculateZones();
  zones.forEach((zone) => {
    if (!stats[zone.categoryId]) {
      stats[zone.categoryId] = { cellCount: 0, zoneCount: 0, areaSqm: 0 };
    }
    stats[zone.categoryId].zoneCount += 1;
  });

  const cellArea = getCellAreaSqm();
  Object.values(stats).forEach((item) => {
    item.areaSqm = item.cellCount * cellArea;
  });

  return stats;
}

function calculateZones() {
  const grouped = new Map();

  Object.entries(plan.cells).forEach(([key, cell]) => {
    const zoneId = cell.zoneId || createZoneId();
    if (!cell.zoneId) {
      cell.zoneId = zoneId;
    }
    if (!grouped.has(zoneId)) {
      grouped.set(zoneId, {
        id: zoneId,
        categoryId: cell.categoryId,
        cellKeys: []
      });
    }
    grouped.get(zoneId).cellKeys.push(key);
  });

  return [...grouped.values()].map((zone) => ({
    ...zone,
    signature: zoneSignature(zone.id)
  }));
}

function findZoneAtCell(x, y) {
  const key = cellKey(x, y);
  return calculateZones().find((zone) => zone.cellKeys.includes(key)) || null;
}

function getSelectedZone() {
  if (!selectedZoneSignature) {
    return null;
  }
  return calculateZones().find((zone) => zone.signature === selectedZoneSignature) || null;
}

function deleteSelectedZone() {
  const zone = getSelectedZone();
  if (!zone) {
    selectedZoneSignature = null;
    draw();
    return;
  }

  zone.cellKeys.forEach((key) => delete plan.cells[key]);
  selectedZoneSignature = null;
  transformDraft = null;
  persistPlan();
  updateUi();
}

function rotateSelectedZone() {
  const zone = getSelectedZone();
  if (!zone) {
    showSaveStatus("No zone selected");
    draw();
    return;
  }

  const rotatedKeys = rotateCellKeysClockwise(zone.cellKeys);
  if (!canPlaceCellKeys(rotatedKeys, new Set(zone.cellKeys))) {
    showSaveStatus("Overlap blocked");
    draw();
    return;
  }

  zone.cellKeys.forEach((key) => delete plan.cells[key]);
  rotatedKeys.forEach((key) => {
    plan.cells[key] = { categoryId: zone.categoryId, zoneId: zone.id };
  });
  selectedZoneSignature = zoneSignature(zone.id);
  persistPlan();
  updateUi();
}

function rotateCellKeysClockwise(keys) {
  const coords = keys.map(parseCellKey);
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);

  return coords.map(([x, y]) => {
    const rotatedX = minX + (y - minY);
    const rotatedY = minY + (maxX - x);
    return cellKey(rotatedX, rotatedY);
  });
}

function offsetCellKeys(keys, dx, dy) {
  return keys.map((key) => {
    const [x, y] = parseCellKey(key);
    return cellKey(x + dx, y + dy);
  });
}

function canPlaceCellKeys(keys, ignoreKeys) {
  return keys.every((key) => !plan.cells[key] || ignoreKeys.has(key));
}

function createZoneId() {
  return `z-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitZoneIntoConnectedComponents(zoneId) {
  const zoneKeys = Object.keys(plan.cells).filter((key) => plan.cells[key].zoneId === zoneId);
  const visited = new Set();
  let componentIndex = 0;

  zoneKeys.forEach((startKey) => {
    if (visited.has(startKey)) {
      return;
    }

    const component = [];
    const startCell = plan.cells[startKey];
    const stack = [startKey];
    visited.add(startKey);

    while (stack.length) {
      const key = stack.pop();
      component.push(key);
      const [x, y] = parseCellKey(key);
      neighbors(x, y).forEach((neighborKey) => {
        if (visited.has(neighborKey)) {
          return;
        }
        const neighbor = plan.cells[neighborKey];
        if (
          neighbor &&
          neighbor.zoneId === zoneId &&
          neighbor.categoryId === startCell.categoryId
        ) {
          visited.add(neighborKey);
          stack.push(neighborKey);
        }
      });
    }

    const componentZoneId = componentIndex === 0 ? zoneId : createZoneId();
    component.forEach((key) => {
      plan.cells[key].zoneId = componentZoneId;
    });
    componentIndex += 1;
  });
}

function zoneSignature(zoneId) {
  return `zone:${zoneId}`;
}

function neighbors(x, y) {
  return [
    cellKey(x + 1, y),
    cellKey(x - 1, y),
    cellKey(x, y + 1),
    cellKey(x, y - 1)
  ];
}

function getCellAreaSqm() {
  const meters = plan.moduleSizeMm / 1000;
  return meters * meters;
}

function persistPlan() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
  showSaveStatus("Auto-saved");
}

function restorePlan() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return;
  }

  try {
    const parsed = JSON.parse(saved);
    plan = normalizePlan(parsed);
    showSaveStatus("Restored");
  } catch (error) {
    showSaveStatus("Saved plan unreadable");
  }
}

function normalizePlan(source) {
  const normalized = clonePlan({
    version: source.version,
    moduleSizeMm: source.moduleSizeMm,
    categories: Array.isArray(source.categories) && source.categories.length ? source.categories : categories,
    cells: source.cells && typeof source.cells === "object" ? source.cells : {}
  });

  Object.keys(normalized.cells).forEach((key) => {
    if (!/^-?\d+,-?\d+$/.test(key) || !normalized.cells[key].categoryId) {
      delete normalized.cells[key];
      return;
    }
    if (typeof normalized.cells[key].zoneId !== "string" || !normalized.cells[key].zoneId.trim()) {
      delete normalized.cells[key].zoneId;
    }
  });
  normalized.categories = normalized.categories.map((category) => ({
    ...category,
    color: defaultCategoryColors.get(category.id) || category.color
  }));
  assignMissingZoneIds(normalized);

  return normalized;
}

function assignMissingZoneIds(targetPlan) {
  const visited = new Set();

  Object.keys(targetPlan.cells).forEach((startKey) => {
    if (visited.has(startKey) || targetPlan.cells[startKey].zoneId) {
      return;
    }

    const startCell = targetPlan.cells[startKey];
    const zoneId = createZoneId();
    const stack = [startKey];
    visited.add(startKey);

    while (stack.length) {
      const key = stack.pop();
      targetPlan.cells[key].zoneId = zoneId;
      const [x, y] = parseCellKey(key);
      neighbors(x, y).forEach((neighborKey) => {
        if (visited.has(neighborKey)) {
          return;
        }
        const neighbor = targetPlan.cells[neighborKey];
        if (
          neighbor &&
          !neighbor.zoneId &&
          neighbor.categoryId === startCell.categoryId
        ) {
          visited.add(neighborKey);
          stack.push(neighborKey);
        }
      });
    }
  });
}

function saveJson() {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  downloadBlob(blob, `blockplan-${dateStamp()}.json`);
  showSaveStatus("JSON saved");
}

function loadJson(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      plan = normalizePlan(JSON.parse(reader.result));
      selectedZoneSignature = null;
      transformDraft = null;
      activeCategoryId = plan.categories.some((item) => item.id === activeCategoryId)
        ? activeCategoryId
        : plan.categories[0].id;
      persistPlan();
      renderCategoryList();
      updateUi();
      showSaveStatus("JSON loaded");
    } catch (error) {
      showSaveStatus("Load failed");
    } finally {
      loadJsonInput.value = "";
    }
  });
  reader.readAsText(file);
}

function exportPng() {
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

  exportCanvas.toBlob((blob) => {
    if (blob) {
      downloadBlob(blob, `blockplan-${dateStamp()}.png`);
      showSaveStatus("PNG exported");
    }
  }, "image/png");
}

function drawExportGrid(targetCtx, bounds) {
  targetCtx.fillStyle = GRID_DOT_SOFT;
  const radius = 1.2;
  for (let x = bounds.minX; x <= bounds.maxX + 1; x += 1) {
    for (let y = bounds.minY; y <= bounds.maxY + 1; y += 1) {
      targetCtx.beginPath();
      targetCtx.arc(x * CELL_PX, y * CELL_PX, radius, 0, Math.PI * 2);
      targetCtx.fill();
    }
  }
}

function getCellBounds() {
  const keys = Object.keys(plan.cells);
  if (!keys.length) {
    return { minX: -10, minY: -7, maxX: 10, maxY: 7, width: 21, height: 15 };
  }

  return getBoundsForKeys(keys);
}

function getBoundsForKeys(keys) {
  const coords = keys.map(parseCellKey);
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function clearPlan() {
  if (!confirm("Clear all painted cells?")) {
    return;
  }
  plan.cells = {};
  selectedZoneSignature = null;
  transformDraft = null;
  persistPlan();
  updateUi();
}

function resetView() {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  draw();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function showSaveStatus(message) {
  saveStatus.textContent = message;
}

function updateZoomStatus() {
  zoomStatus.textContent = `${Math.round(view.zoom * 100)}%`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function parseCellKey(key) {
  return key.split(",").map(Number);
}

function darkenColor(hex, amount) {
  const cleanHex = hex.replace("#", "");
  const value = Number.parseInt(cleanHex, 16);
  const r = Math.max(0, Math.floor(((value >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.floor(((value >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.floor((value & 255) * (1 - amount)));
  return `rgb(${r}, ${g}, ${b})`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

setup();
