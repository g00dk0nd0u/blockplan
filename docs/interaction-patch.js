"use strict";

// Interaction patch:
// - rectangle paint
// - merge paint into existing same-category zone
// - continuous grid-edge split line
// - improved label anchor
// - Shift multi-select
// - Merge zones
// - selected zone category reassignment
// - Cmd/Ctrl + Z undo
// Loaded after app.js.

let patchPaintDraft = null;
let patchSplitDraft = null;
let patchOriginalDraw = null;

const patchSelectedZoneIds = new Set();
const patchUndoStack = [];
const PATCH_UNDO_LIMIT = 80;

(function setupInteractionPatch() {
  if (!canvas || !ctx) return;

  patchOriginalDraw = draw;
  draw = function patchedDraw() {
    patchOriginalDraw();
    drawPatchPreviews();
  };

  installMergeButton();
  installAddCategoryButton();
  installPatchKeyboardShortcuts();
  installBetterZoneLabelAnchor();
  installCategoryReassignHandler();
  installUndoCaptureHandlers();

  canvas.addEventListener("pointerdown", onPatchPointerDown, true);
  canvas.addEventListener("pointermove", onPatchPointerMove, true);
  canvas.addEventListener("pointerup", onPatchPointerUp, true);
  canvas.addEventListener("pointercancel", onPatchPointerUp, true);
})();


function installAddCategoryButton() {
  const button = document.getElementById("addCategoryButton");
  if (!button) return;

  button.addEventListener("click", () => {
    pushUndoState();

    const nextIndex = plan.categories.length + 1;
    const categoryId = createUniqueCategoryId(`category-${nextIndex}`);
    const category = {
      id: categoryId,
      name: `Category ${nextIndex}`,
      color: getNextCategoryColor(plan.categories.length)
    };

    plan.categories.push(category);
    activeCategoryId = category.id;
    editingCategoryId = category.id;
    editingCategoryFallback = category.name;

    setActiveTool("paint");
    persistPlan();
    renderCategoryList();
    renderDashboard();
    updateUi();
    showSaveStatus(`Added ${category.name}`);
  });
}

function createUniqueCategoryId(baseId) {
  let candidate = baseId;
  let index = 1;
  const existingIds = new Set(plan.categories.map((category) => category.id));

  while (existingIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }

  return candidate;
}

function getNextCategoryColor(index) {
  const hue = (index * 47 + 210) % 360;
  return hslToHex(hue, 28, 52);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }

  const toHex = (value) => {
    const hex = Math.round((value + m) * 255).toString(16);
    return hex.padStart(2, "0");
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function installMergeButton() {
  const toolGrid = document.querySelector(".tool-grid");
  const rotateButton = document.getElementById("rotateToolButton");

  if (!toolGrid || document.getElementById("mergeToolButton")) return;

  const button = document.createElement("button");
  button.id = "mergeToolButton";
  button.type = "button";
  button.className = "tool-button";
  button.textContent = "⊕ Merge";
  button.title = "Merge selected zones";
  button.addEventListener("click", mergeSelectedZones);

  toolGrid.insertBefore(button, rotateButton || null);
}

function installPatchKeyboardShortcuts() {
  window.addEventListener(
    "keydown",
    (event) => {
      if (isEditingText()) return;

      if (event.key === "Escape") {
        patchPaintDraft = null;
        patchSplitDraft = null;
        transformDraft = null;
        cutDraft = null;
        paintStrokeZoneId = null;

        selectedZoneSignature = null;
        patchSelectedZoneIds.clear();

        setActiveTool("select");
        draw();
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && patchSelectedZoneIds.size > 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        deleteMultiSelectedZones();
        return;
      }

      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        event.stopImmediatePropagation();
        mergeSelectedZones();
      }
    },
    true
  );
}

function installUndoCaptureHandlers() {
  window.addEventListener(
    "keydown",
    (event) => {
      if (isEditingText()) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        undoLastAction();
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedZoneSignature) {
        pushUndoState();
      }

      if (event.key.toLowerCase() === "r" && selectedZoneSignature) {
        pushUndoState();
      }
    },
    true
  );

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || isSpaceDown) return;
      if (activeTool !== "select" && activeTool !== "copy") return;

      const cell = eventToCell(event);
      const zone = findZoneAtCell(cell.x, cell.y);
      if (zone) pushUndoState();
    },
    true
  );

  const rotateButton = document.getElementById("rotateToolButton");
  if (rotateButton) {
    rotateButton.addEventListener(
      "click",
      () => {
        if (selectedZoneSignature) pushUndoState();
      },
      true
    );
  }

  const clearButton = document.getElementById("clearButton");
  if (clearButton) {
    clearButton.addEventListener(
      "click",
      () => {
        if (Object.keys(plan.cells).length) pushUndoState();
      },
      true
    );
  }
}

function pushUndoState() {
  try {
    patchUndoStack.push(JSON.stringify(plan));

    if (patchUndoStack.length > PATCH_UNDO_LIMIT) {
      patchUndoStack.shift();
    }
  } catch (error) {
    console.warn("Undo snapshot failed", error);
  }
}

function undoLastAction() {
  if (!patchUndoStack.length) {
    showSaveStatus("Nothing to undo");
    return;
  }

  try {
    const previous = JSON.parse(patchUndoStack.pop());
    plan = clonePlan(previous);

    patchPaintDraft = null;
    patchSplitDraft = null;
    transformDraft = null;
    cutDraft = null;
    paintStrokeZoneId = null;
    selectedZoneSignature = null;
    patchSelectedZoneIds.clear();

    persistPlan();
    renderCategoryList();
    updateUi();
    showSaveStatus("Undo");
  } catch (error) {
    console.error("Undo failed", error);
    showSaveStatus("Undo failed");
  }
}

function installBetterZoneLabelAnchor() {
  getZoneLabelAnchor = function betterZoneLabelAnchor(cellKeys) {
    const cellSet = new Set(cellKeys);
    const centers = cellKeys.map((key) => {
      const [x, y] = parseCellKey(key);
      return {
        key,
        x,
        y,
        cx: (x + 0.5) * CELL_PX,
        cy: (y + 0.5) * CELL_PX
      };
    });

    const centroid = centers.reduce(
      (total, item) => ({
        x: total.x + item.cx,
        y: total.y + item.cy
      }),
      { x: 0, y: 0 }
    );

    centroid.x /= centers.length;
    centroid.y /= centers.length;

    let best = centers[0];
    let bestScore = -Infinity;

    centers.forEach((item) => {
      const inwardDistance = distanceToNearestEmptyCell(item.x, item.y, cellSet);
      const centroidDistance = Math.hypot(item.cx - centroid.x, item.cy - centroid.y) / CELL_PX;
      const score = inwardDistance * 100 - centroidDistance;

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    });

    return { x: best.cx, y: best.cy };
  };
}

function distanceToNearestEmptyCell(x, y, cellSet) {
  const maxRadius = 24;

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        if (!cellSet.has(cellKey(x + dx, y + dy))) return radius;
      }
    }
  }

  return maxRadius;
}

function onPatchPointerDown(event) {
  if (event.button !== 0 || isSpaceDown) return;

  if (activeTool === "select" && event.shiftKey) {
    stopOriginalPointerAction(event);
    toggleZoneMultiSelection(event);
    return;
  }

  if (activeTool === "paint") {
    stopOriginalPointerAction(event);
    canvas.setPointerCapture(event.pointerId);

    const startCell = eventToCell(event);
    const startKey = cellKey(startCell.x, startCell.y);
    const startData = plan.cells[startKey];
    const zoneId =
      startData && startData.categoryId === activeCategoryId
        ? startData.zoneId
        : createZoneId();

    patchPaintDraft = {
      startCell,
      currentCell: startCell,
      categoryId: activeCategoryId,
      zoneId
    };

    paintStrokeZoneId = null;
    isPainting = false;
    selectedZoneSignature = null;
    patchSelectedZoneIds.clear();

    updateCellStatus(event);
    draw();
    return;
  }

  if (activeTool === "cut") {
    stopOriginalPointerAction(event);
    canvas.setPointerCapture(event.pointerId);

    const point = eventToGridPoint(event);
    patchSplitDraft = {
      edges: new Set(),
      segments: [],
      lastPoint: point
    };

    cutDraft = null;
    updateCellStatus(event);
    draw();
  }
}

function onPatchPointerMove(event) {
  if (!patchPaintDraft && !patchSplitDraft) return;

  stopOriginalPointerAction(event);
  updateCellStatus(event);

  if (patchPaintDraft) {
    patchPaintDraft.currentCell = eventToCell(event);
    draw();
    return;
  }

  if (patchSplitDraft) {
    const point = eventToGridPoint(event);
    addContinuousSplitPath(patchSplitDraft.lastPoint, point);
    patchSplitDraft.lastPoint = point;
    draw();
  }
}

function onPatchPointerUp(event) {
  if (!patchPaintDraft && !patchSplitDraft) return;

  stopOriginalPointerAction(event);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (patchPaintDraft) {
    commitRectanglePaint();
    patchPaintDraft = null;
    return;
  }

  if (patchSplitDraft) {
    commitGridEdgeSplit();
    patchSplitDraft = null;
  }
}

function stopOriginalPointerAction(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function eventToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
}

function eventToGridPoint(event) {
  const world = eventToWorld(event);
  return {
    x: Math.round(world.x / CELL_PX),
    y: Math.round(world.y / CELL_PX)
  };
}

function commitRectanglePaint() {
  const draft = patchPaintDraft;
  pushUndoState();

  const minX = Math.min(draft.startCell.x, draft.currentCell.x);
  const maxX = Math.max(draft.startCell.x, draft.currentCell.x);
  const minY = Math.min(draft.startCell.y, draft.currentCell.y);
  const maxY = Math.max(draft.startCell.y, draft.currentCell.y);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      plan.cells[cellKey(x, y)] = {
        categoryId: draft.categoryId,
        zoneId: draft.zoneId
      };
    }
  }

  selectedZoneSignature = null;
  patchSelectedZoneIds.clear();
  patchPaintDraft = null;

  persistPlan();
  updateUi();
}

function addContinuousSplitPath(fromPoint, toPoint) {
  if (!patchSplitDraft) return;
  if (fromPoint.x === toPoint.x && fromPoint.y === toPoint.y) return;

  let cursor = { ...fromPoint };
  const dx = toPoint.x - fromPoint.x;
  const dy = toPoint.y - fromPoint.y;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);

  if (horizontalFirst) {
    cursor = addHorizontalSplitSegments(cursor, toPoint.x);
    cursor = addVerticalSplitSegments(cursor, toPoint.y);
  } else {
    cursor = addVerticalSplitSegments(cursor, toPoint.y);
    cursor = addHorizontalSplitSegments(cursor, toPoint.x);
  }
}

function addHorizontalSplitSegments(cursor, targetX) {
  const step = Math.sign(targetX - cursor.x);

  while (cursor.x !== targetX && step !== 0) {
    const next = { x: cursor.x + step, y: cursor.y };
    addSplitSegment(cursor, next);
    cursor = next;
  }

  return cursor;
}

function addVerticalSplitSegments(cursor, targetY) {
  const step = Math.sign(targetY - cursor.y);

  while (cursor.y !== targetY && step !== 0) {
    const next = { x: cursor.x, y: cursor.y + step };
    addSplitSegment(cursor, next);
    cursor = next;
  }

  return cursor;
}

function addSplitSegment(a, b) {
  const edge = splitEdgeFromGridSegment(a, b);
  if (!edge) return;

  if (!patchSplitDraft.edges.has(edge.id)) {
    patchSplitDraft.edges.add(edge.id);
    patchSplitDraft.segments.push({
      a: { ...a },
      b: { ...b },
      edgeId: edge.id
    });
  }
}

function splitEdgeFromGridSegment(a, b) {
  if (a.y === b.y && Math.abs(a.x - b.x) === 1) {
    const col = Math.min(a.x, b.x);
    return makeSplitEdge(cellKey(col, a.y - 1), cellKey(col, a.y));
  }

  if (a.x === b.x && Math.abs(a.y - b.y) === 1) {
    const row = Math.min(a.y, b.y);
    return makeSplitEdge(cellKey(a.x - 1, row), cellKey(a.x, row));
  }

  return null;
}

function makeSplitEdge(keyA, keyB) {
  if (!keyA || !keyB || keyA === keyB) return null;
  const ordered = [keyA, keyB].sort();

  return {
    id: `${ordered[0]}|${ordered[1]}`,
    a: ordered[0],
    b: ordered[1]
  };
}

function commitGridEdgeSplit() {
  const splitEdges = patchSplitDraft.edges;

  if (!splitEdges.size) {
    draw();
    return;
  }

  const affectedZoneIds = new Set();

  splitEdges.forEach((edgeId) => {
    const [a, b] = edgeId.split("|");
    const cellA = plan.cells[a];
    const cellB = plan.cells[b];

    if (cellA && cellB && cellA.zoneId && cellA.zoneId === cellB.zoneId) {
      affectedZoneIds.add(cellA.zoneId);
    }
  });

  if (!affectedZoneIds.size) {
    showSaveStatus("Cut did not split zone");
    draw();
    return;
  }

  pushUndoState();

  let didSplit = false;
  let lastZoneId = null;

  affectedZoneIds.forEach((zoneId) => {
    const result = splitZoneByBlockedEdges(zoneId, splitEdges);
    if (result.didSplit) {
      didSplit = true;
      lastZoneId = result.lastZoneId;
    }
  });

  if (didSplit && lastZoneId) {
    selectedZoneSignature = null;
    patchSelectedZoneIds.clear();
    patchSplitDraft = null;
    persistPlan();
    updateUi();
  } else {
    undoDiscardLastNoopSnapshot();
    showSaveStatus("Cut did not split zone");
    draw();
  }
}

function undoDiscardLastNoopSnapshot() {
  if (patchUndoStack.length) patchUndoStack.pop();
}

function splitZoneByBlockedEdges(zoneId, blockedEdges) {
  const zoneKeys = Object.keys(plan.cells).filter((key) => plan.cells[key].zoneId === zoneId);

  if (zoneKeys.length < 2) {
    return { didSplit: false, lastZoneId: zoneId };
  }

  const zoneSet = new Set(zoneKeys);
  const visited = new Set();
  const components = [];

  zoneKeys.forEach((startKey) => {
    if (visited.has(startKey)) return;

    const component = [];
    const stack = [startKey];
    visited.add(startKey);

    while (stack.length) {
      const key = stack.pop();
      component.push(key);

      const [x, y] = parseCellKey(key);

      neighbors(x, y).forEach((neighborKey) => {
        if (!zoneSet.has(neighborKey)) return;
        if (visited.has(neighborKey)) return;

        const edge = makeSplitEdge(key, neighborKey);
        if (edge && blockedEdges.has(edge.id)) return;

        visited.add(neighborKey);
        stack.push(neighborKey);
      });
    }

    components.push(component);
  });

  if (components.length <= 1) {
    return { didSplit: false, lastZoneId: zoneId };
  }

  let lastZoneId = zoneId;

  components.forEach((component, index) => {
    const nextZoneId = index === 0 ? zoneId : createZoneId();
    lastZoneId = nextZoneId;

    component.forEach((key) => {
      plan.cells[key].zoneId = nextZoneId;
    });
  });

  return { didSplit: true, lastZoneId };
}

function toggleZoneMultiSelection(event) {
  addCurrentSingleSelectionToMulti();

  const cell = eventToCell(event);
  const zone = findZoneAtCell(cell.x, cell.y);

  if (!zone) {
    draw();
    return;
  }

  if (patchSelectedZoneIds.has(zone.id)) {
    patchSelectedZoneIds.delete(zone.id);
  } else {
    patchSelectedZoneIds.add(zone.id);
  }

  selectedZoneSignature = zone.signature;
  draw();
}

function addCurrentSingleSelectionToMulti() {
  if (!selectedZoneSignature) return;

  const zone = calculateZones().find((item) => item.signature === selectedZoneSignature);

  if (zone) {
    patchSelectedZoneIds.add(zone.id);
  }
}

function mergeSelectedZones() {
  addCurrentSingleSelectionToMulti();

  const zones = calculateZones().filter((zone) => patchSelectedZoneIds.has(zone.id));

  if (zones.length < 2) {
    showSaveStatus("Select multiple zones to merge");
    draw();
    return;
  }

  const categoryId = zones[0].categoryId;

  if (!zones.every((zone) => zone.categoryId === categoryId)) {
    showSaveStatus("Merge requires same category");
    draw();
    return;
  }

  pushUndoState();

  const targetZoneId = zones[0].id;

  zones.forEach((zone) => {
    zone.cellKeys.forEach((key) => {
      plan.cells[key].zoneId = targetZoneId;
      plan.cells[key].categoryId = categoryId;
    });
  });

  patchSelectedZoneIds.clear();
  patchSelectedZoneIds.add(targetZoneId);
  selectedZoneSignature = zoneSignature(targetZoneId);

  persistPlan();
  updateUi();
}

function deleteMultiSelectedZones() {
  if (!patchSelectedZoneIds.size) return;

  pushUndoState();

  patchSelectedZoneIds.forEach((zoneId) => {
    Object.keys(plan.cells).forEach((key) => {
      if (plan.cells[key].zoneId === zoneId) {
        delete plan.cells[key];
      }
    });
  });

  patchSelectedZoneIds.clear();
  selectedZoneSignature = null;

  persistPlan();
  updateUi();
}

function installCategoryReassignHandler() {
  if (!categoryList) return;

  categoryList.addEventListener(
    "click",
    (event) => {
      const row = event.target.closest(".category-button");
      if (!row) return;
      if (event.target.closest(".category-name-input")) return;

      const categoryId = row.dataset.categoryId;
      if (!categoryId) return;

      const targetZoneIds = getSelectedZoneIdsForReassign();
      if (!targetZoneIds.size) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      reassignSelectedZones(categoryId, targetZoneIds);
    },
    true
  );

  categoryList.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;

      const row = event.target.closest(".category-button");
      if (!row) return;

      const categoryId = row.dataset.categoryId;
      if (!categoryId) return;

      const targetZoneIds = getSelectedZoneIdsForReassign();
      if (!targetZoneIds.size) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      reassignSelectedZones(categoryId, targetZoneIds);
    },
    true
  );
}

function getSelectedZoneIdsForReassign() {
  const targetZoneIds = new Set(patchSelectedZoneIds);

  if (selectedZoneSignature) {
    const selectedZone = calculateZones().find((zone) => zone.signature === selectedZoneSignature);
    if (selectedZone) {
      targetZoneIds.add(selectedZone.id);
    }
  }

  return targetZoneIds;
}

function reassignSelectedZones(categoryId, targetZoneIds) {
  const targetCells = Object.values(plan.cells).filter((cell) => targetZoneIds.has(cell.zoneId));

  if (!targetCells.length) {
    showSaveStatus("No selected zone");
    draw();
    return;
  }

  if (targetCells.every((cell) => cell.categoryId === categoryId)) {
    showSaveStatus("Already same category");
    draw();
    return;
  }

  pushUndoState();

  targetCells.forEach((cell) => {
    cell.categoryId = categoryId;
  });

  activeCategoryId = categoryId;
  patchSelectedZoneIds.clear();
  targetZoneIds.forEach((zoneId) => patchSelectedZoneIds.add(zoneId));

  const firstZoneId = [...targetZoneIds][0];
  selectedZoneSignature = zoneSignature(firstZoneId);

  persistPlan();
  renderCategoryList();
  updateUi();

  const category = categoryById(categoryId);
  showSaveStatus(`Changed to ${category.name}`);
}

function drawPatchPreviews() {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);

  if (patchPaintDraft) {
    drawRectanglePaintPreview(ctx, patchPaintDraft);
  }

  if (patchSplitDraft) {
    drawContinuousSplitPreview(ctx, patchSplitDraft.segments);
  }

  drawMultiSelectionOverlay(ctx);

  ctx.restore();
}

function drawRectanglePaintPreview(targetCtx, draft) {
  const category = categoryById(draft.categoryId);

  const minX = Math.min(draft.startCell.x, draft.currentCell.x);
  const maxX = Math.max(draft.startCell.x, draft.currentCell.x);
  const minY = Math.min(draft.startCell.y, draft.currentCell.y);
  const maxY = Math.max(draft.startCell.y, draft.currentCell.y);

  const x = minX * CELL_PX;
  const y = minY * CELL_PX;
  const width = (maxX - minX + 1) * CELL_PX;
  const height = (maxY - minY + 1) * CELL_PX;

  targetCtx.save();
  targetCtx.fillStyle = category.color;
  targetCtx.globalAlpha = 0.34;
  targetCtx.fillRect(x, y, width, height);

  targetCtx.globalAlpha = 1;
  targetCtx.strokeStyle = darkenColor(category.color, 0.25);
  targetCtx.lineWidth = 1.2;
  targetCtx.setLineDash([5, 4]);
  targetCtx.strokeRect(x, y, width, height);
  targetCtx.setLineDash([]);
  targetCtx.restore();
}

function drawContinuousSplitPreview(targetCtx, segments) {
  if (!segments.length) return;

  targetCtx.save();
  targetCtx.strokeStyle = "rgba(28, 27, 25, 0.82)";
  targetCtx.lineWidth = 1.6;
  targetCtx.setLineDash([7, 5]);
  targetCtx.beginPath();

  segments.forEach((segment) => {
    targetCtx.moveTo(segment.a.x * CELL_PX, segment.a.y * CELL_PX);
    targetCtx.lineTo(segment.b.x * CELL_PX, segment.b.y * CELL_PX);
  });

  targetCtx.stroke();
  targetCtx.setLineDash([]);
  targetCtx.restore();
}

function drawMultiSelectionOverlay(targetCtx) {
  if (!patchSelectedZoneIds.size) return;

  calculateZones()
    .filter((zone) => patchSelectedZoneIds.has(zone.id))
    .forEach((zone) => {
      const loops = buildZoneBoundaryLoops(zone.cellKeys);
      if (!loops.length) return;

      targetCtx.save();
      targetCtx.beginPath();
      loops.forEach((loop) => addRoundedLoopToPath(targetCtx, loop));
      targetCtx.strokeStyle = "rgba(28, 27, 25, 0.82)";
      targetCtx.lineWidth = 1.8;
      targetCtx.setLineDash([5, 4]);
      targetCtx.stroke();
      targetCtx.setLineDash([]);
      targetCtx.restore();
    });
}