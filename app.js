"use strict";

const STORAGE_KEY = "blockplan.currentPlan.v1";
const CELL_PX = 36;

const categories = [
  { id: "unassigned", name: "Unassigned", color: "#cbd5e1" },
  { id: "office", name: "Office", color: "#60a5fa" },
  { id: "meeting", name: "Meeting", color: "#f59e0b" },
  { id: "core", name: "Core", color: "#ef4444" },
  { id: "circulation", name: "Circulation", color: "#22c55e" },
  { id: "mep", name: "MEP", color: "#a855f7" }
];

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
const moduleReadout = document.getElementById("moduleReadout");
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
    cells: source.cells ? { ...source.cells } : {}
  };
}

function categoryById(categoryId) {
  return plan.categories.find((category) => category.id === categoryId) || plan.categories[0];
}

function setup() {
  restorePlan();
  renderCategoryList();
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
  document.getElementById("resetViewButton").addEventListener("click", resetView);
  loadJsonInput.addEventListener("change", loadJson);

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointerAction);
  canvas.addEventListener("pointercancel", endPointerAction);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      isSpaceDown = true;
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      isSpaceDown = false;
      if (!isPanning) {
        canvas.classList.remove("is-panning");
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
      renderCategoryList();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activeCategoryId = category.id;
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
  renderCategoryList();
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

function onPointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  lastPointer = { x: event.clientX, y: event.clientY };
  const shouldPan = event.button === 1 || isSpaceDown;

  if (shouldPan) {
    isPanning = true;
    canvas.classList.add("is-panning");
    return;
  }

  if (event.button !== 0) {
    return;
  }

  isPainting = true;
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
}

function endPointerAction(event) {
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (isPainting) {
    persistPlan();
    updateUi();
  }

  isPainting = false;
  isPanning = false;
  if (!isSpaceDown) {
    canvas.classList.remove("is-panning");
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
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const cell = {
    x: Math.floor(world.x / CELL_PX),
    y: Math.floor(world.y / CELL_PX)
  };
  const key = cellKey(cell.x, cell.y);
  const existing = plan.cells[key];

  if (existing && existing.categoryId === activeCategoryId) {
    return;
  }

  plan.cells[key] = { categoryId: activeCategoryId };
  draw();
  updateUi();
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
  ctx.fillStyle = "#e9eef4";
  ctx.fillRect(0, 0, rect.width, rect.height);
}

function drawZones() {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  drawZonesOnContext(ctx, calculateZones());
  ctx.restore();
}

function drawZonesOnContext(targetCtx, zones) {
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
    targetCtx.globalAlpha = isUnassigned ? 0.34 : 0.84;
    targetCtx.fill("evenodd");

    targetCtx.globalAlpha = 1;
    targetCtx.strokeStyle = isUnassigned ? "rgba(100, 116, 139, 0.46)" : darkenColor(category.color, 0.24);
    targetCtx.lineWidth = isUnassigned ? 1.6 : 2.5;
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    targetCtx.stroke();
    targetCtx.restore();
  });
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
  if (spacing < 6) {
    return;
  }

  const startX = view.panX % spacing;
  const startY = view.panY % spacing;
  ctx.beginPath();
  ctx.strokeStyle = spacing < 18 ? "rgba(100, 116, 139, 0.20)" : "rgba(100, 116, 139, 0.32)";
  ctx.lineWidth = 1;

  for (let x = startX; x < rect.width; x += spacing) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rect.height);
  }

  for (let y = startY; y < rect.height; y += spacing) {
    ctx.moveTo(0, y);
    ctx.lineTo(rect.width, y);
  }

  ctx.stroke();
}

function updateUi() {
  moduleSizeSelect.value = String(plan.moduleSizeMm);
  moduleReadout.textContent = `${plan.moduleSizeMm} mm`;
  cellAreaReadout.textContent = `${getCellAreaSqm().toFixed(2)} ㎡`;
  renderDashboard();
  draw();
}

function renderDashboard() {
  const stats = calculateDashboard();
  dashboard.innerHTML = "";

  plan.categories.forEach((category) => {
    const categoryStats = stats[category.id] || { cellCount: 0, zoneCount: 0, areaSqm: 0 };
    const row = document.createElement("article");
    row.className = "dashboard-row";
    row.innerHTML = `
      <div class="dashboard-title">
        <span class="category-swatch" style="background:${category.color}"></span>
        <span>${category.name}</span>
      </div>
      <div class="dashboard-stats">
        <div class="stat">
          <span class="stat-label">Area ㎡</span>
          <span class="stat-value">${categoryStats.areaSqm.toFixed(2)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Zones</span>
          <span class="stat-value">${categoryStats.zoneCount}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Cells</span>
          <span class="stat-value">${categoryStats.cellCount}</span>
        </div>
      </div>
    `;
    dashboard.appendChild(row);
  });
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
  const visited = new Set();
  const zones = [];

  Object.keys(plan.cells).forEach((startKey) => {
    if (visited.has(startKey)) {
      return;
    }

    const startCell = plan.cells[startKey];
    const zone = [];
    const stack = [startKey];
    visited.add(startKey);

    while (stack.length) {
      const key = stack.pop();
      zone.push(key);
      const [x, y] = parseCellKey(key);
      neighbors(x, y).forEach((neighborKey) => {
        if (visited.has(neighborKey)) {
          return;
        }
        const neighbor = plan.cells[neighborKey];
        if (neighbor && neighbor.categoryId === startCell.categoryId) {
          visited.add(neighborKey);
          stack.push(neighborKey);
        }
      });
    }

    zones.push({
      id: `${startCell.categoryId}-${zones.length + 1}`,
      categoryId: startCell.categoryId,
      cellKeys: zone
    });
  });

  return zones;
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
    }
  });

  return normalized;
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

  exportCtx.fillStyle = "#ffffff";
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
  targetCtx.beginPath();
  targetCtx.strokeStyle = "#e0e7ef";
  targetCtx.lineWidth = 1;
  for (let x = bounds.minX; x <= bounds.maxX + 1; x += 1) {
    targetCtx.moveTo(x * CELL_PX, bounds.minY * CELL_PX);
    targetCtx.lineTo(x * CELL_PX, (bounds.maxY + 1) * CELL_PX);
  }
  for (let y = bounds.minY; y <= bounds.maxY + 1; y += 1) {
    targetCtx.moveTo(bounds.minX * CELL_PX, y * CELL_PX);
    targetCtx.lineTo((bounds.maxX + 1) * CELL_PX, y * CELL_PX);
  }
  targetCtx.stroke();
}

function getCellBounds() {
  const keys = Object.keys(plan.cells);
  if (!keys.length) {
    return { minX: -10, minY: -7, maxX: 10, maxY: 7, width: 21, height: 15 };
  }

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
