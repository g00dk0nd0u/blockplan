"use strict";

// Interaction patch: rectangular paint and grid-edge cut.
// This file intentionally sits after app.js and intercepts only Paint/Cut pointer actions.

let patchPaintDraft = null;
let patchCutDraft = null;
let patchOriginalDraw = null;

(function setupInteractionPatch() {
  if (!canvas || !ctx) {
    return;
  }

  patchOriginalDraw = draw;
  draw = function patchedDraw() {
    patchOriginalDraw();
    drawPatchPreviews();
  };

  canvas.addEventListener("pointerdown", onPatchPointerDown, true);
  canvas.addEventListener("pointermove", onPatchPointerMove, true);
  canvas.addEventListener("pointerup", onPatchPointerUp, true);
  canvas.addEventListener("pointercancel", onPatchPointerUp, true);
})();

function onPatchPointerDown(event) {
  if (event.button !== 0 || event.button === 1 || isSpaceDown) {
    return;
  }

  if (activeTool === "paint") {
    stopOriginalPointerAction(event);
    canvas.setPointerCapture(event.pointerId);
    const startCell = eventToCell(event);
    patchPaintDraft = {
      startCell,
      currentCell: startCell,
      categoryId: activeCategoryId,
      zoneId: createZoneId()
    };
    paintStrokeZoneId = null;
    isPainting = false;
    selectedZoneSignature = null;
    updateCellStatus(event);
    draw();
    return;
  }

  if (activeTool === "cut") {
    stopOriginalPointerAction(event);
    canvas.setPointerCapture(event.pointerId);
    const world = eventToWorld(event);
    patchCutDraft = {
      edges: new Set(),
      lastWorld: world
    };
    cutDraft = null;
    addCutEdgesBetween(world, world);
    updateCellStatus(event);
    draw();
  }
}

function onPatchPointerMove(event) {
  if (!patchPaintDraft && !patchCutDraft) {
    return;
  }

  stopOriginalPointerAction(event);
  updateCellStatus(event);

  if (patchPaintDraft) {
    patchPaintDraft.currentCell = eventToCell(event);
    draw();
    return;
  }

  if (patchCutDraft) {
    const world = eventToWorld(event);
    addCutEdgesBetween(patchCutDraft.lastWorld, world);
    patchCutDraft.lastWorld = world;
    draw();
  }
}

function onPatchPointerUp(event) {
  if (!patchPaintDraft && !patchCutDraft) {
    return;
  }

  stopOriginalPointerAction(event);
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (patchPaintDraft) {
    commitRectanglePaint();
    patchPaintDraft = null;
    return;
  }

  if (patchCutDraft) {
    commitGridEdgeCut();
    patchCutDraft = null;
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

function commitRectanglePaint() {
  const draft = patchPaintDraft;
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

  selectedZoneSignature = zoneSignature(draft.zoneId);
  persistPlan();
  updateUi();
}

function addCutEdgesBetween(fromWorld, toWorld) {
  if (!patchCutDraft) {
    return;
  }

  const distancePx = Math.hypot(toWorld.x - fromWorld.x, toWorld.y - fromWorld.y);
  const steps = Math.max(1, Math.ceil(distancePx / (CELL_PX / 4)));

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const world = {
      x: fromWorld.x + (toWorld.x - fromWorld.x) * t,
      y: fromWorld.y + (toWorld.y - fromWorld.y) * t
    };
    const edge = nearestGridCutEdge(world);
    if (edge) {
      patchCutDraft.edges.add(edge.id);
    }
  }
}

function nearestGridCutEdge(world) {
  const gridX = Math.round(world.x / CELL_PX);
  const gridY = Math.round(world.y / CELL_PX);
  const distToVertical = Math.abs(world.x - gridX * CELL_PX);
  const distToHorizontal = Math.abs(world.y - gridY * CELL_PX);

  if (distToVertical <= distToHorizontal) {
    const row = Math.floor(world.y / CELL_PX);
    const left = cellKey(gridX - 1, row);
    const right = cellKey(gridX, row);
    return makeCutEdge(left, right);
  }

  const col = Math.floor(world.x / CELL_PX);
  const top = cellKey(col, gridY - 1);
  const bottom = cellKey(col, gridY);
  return makeCutEdge(top, bottom);
}

function makeCutEdge(keyA, keyB) {
  if (!keyA || !keyB || keyA === keyB) {
    return null;
  }
  const ordered = [keyA, keyB].sort();
  return {
    id: `${ordered[0]}|${ordered[1]}`,
    a: ordered[0],
    b: ordered[1]
  };
}

function commitGridEdgeCut() {
  const cutEdges = patchCutDraft.edges;
  if (!cutEdges.size) {
    draw();
    return;
  }

  const affectedZoneIds = new Set();
  cutEdges.forEach((edgeId) => {
    const [a, b] = edgeId.split("|");
    const cellA = plan.cells[a];
    const cellB = plan.cells[b];
    if (cellA && cellB && cellA.zoneId && cellA.zoneId === cellB.zoneId) {
      affectedZoneIds.add(cellA.zoneId);
    }
  });

  let didSplit = false;
  let lastZoneId = null;
  affectedZoneIds.forEach((zoneId) => {
    const result = splitZoneByBlockedEdges(zoneId, cutEdges);
    if (result.didSplit) {
      didSplit = true;
      lastZoneId = result.lastZoneId;
    }
  });

  if (didSplit && lastZoneId) {
    selectedZoneSignature = zoneSignature(lastZoneId);
    persistPlan();
    updateUi();
  } else {
    showSaveStatus("Cut did not split zone");
    draw();
  }
}

function splitZoneByBlockedEdges(zoneId, cutEdges) {
  const zoneKeys = Object.keys(plan.cells).filter((key) => plan.cells[key].zoneId === zoneId);
  if (zoneKeys.length < 2) {
    return { didSplit: false, lastZoneId: zoneId };
  }

  const zoneSet = new Set(zoneKeys);
  const visited = new Set();
  const components = [];

  zoneKeys.forEach((startKey) => {
    if (visited.has(startKey)) {
      return;
    }

    const component = [];
    const stack = [startKey];
    visited.add(startKey);

    while (stack.length) {
      const key = stack.pop();
      component.push(key);
      const [x, y] = parseCellKey(key);
      neighbors(x, y).forEach((neighborKey) => {
        if (!zoneSet.has(neighborKey) || visited.has(neighborKey)) {
          return;
        }
        const edge = makeCutEdge(key, neighborKey);
        if (edge && cutEdges.has(edge.id)) {
          return;
        }
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

function drawPatchPreviews() {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);

  if (patchPaintDraft) {
    drawRectanglePaintPreview(ctx, patchPaintDraft);
  }

  if (patchCutDraft) {
    drawGridEdgeCutPreview(ctx, patchCutDraft.edges);
  }

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

function drawGridEdgeCutPreview(targetCtx, edgeIds) {
  if (!edgeIds.size) {
    return;
  }

  targetCtx.save();
  targetCtx.strokeStyle = "rgba(28, 27, 25, 0.82)";
  targetCtx.lineWidth = 1.6;
  targetCtx.setLineDash([7, 5]);
  targetCtx.beginPath();

  edgeIds.forEach((edgeId) => {
    const [a, b] = edgeId.split("|");
    const [ax, ay] = parseCellKey(a);
    const [bx, by] = parseCellKey(b);

    if (ay === by && Math.abs(ax - bx) === 1) {
      const x = Math.max(ax, bx) * CELL_PX;
      const y = ay * CELL_PX;
      targetCtx.moveTo(x, y);
      targetCtx.lineTo(x, y + CELL_PX);
    } else if (ax === bx && Math.abs(ay - by) === 1) {
      const x = ax * CELL_PX;
      const y = Math.max(ay, by) * CELL_PX;
      targetCtx.moveTo(x, y);
      targetCtx.lineTo(x + CELL_PX, y);
    }
  });

  targetCtx.stroke();
  targetCtx.setLineDash([]);
  targetCtx.restore();
}
