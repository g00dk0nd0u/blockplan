"use strict";

(function installBubbleEditor() {
  const workspace = document.getElementById("bubbleWorkspace");
  const scene = document.getElementById("bubbleScene");
  const connectorLayer = document.getElementById("bubbleConnectorLayer");
  const bubbleLayer = document.getElementById("bubbleLayer");
  const popover = document.getElementById("connectorPopover");
  const zoomReadout = document.getElementById("bubbleZoomStatus");
  const editorView = { zoom: 1, panX: 0, panY: 0 };
  let mode = "block";
  let selectedBubbleId = null;
  let selectedConnectorId = null;
  let pointerAction = null;
  let spaceDown = false;

  function diameter(bubble) {
    return bubble.size === null ? 104 : clamp(72 + Math.sqrt(bubble.size.value) * 8, 86, 190);
  }

  function worldPoint(clientX, clientY) {
    const rect = workspace.getBoundingClientRect();
    return {
      x: (clientX - rect.left - editorView.panX) / editorView.zoom,
      y: (clientY - rect.top - editorView.panY) / editorView.zoom
    };
  }

  function nextId(prefix, items) {
    const ids = new Set(items.map((item) => item.id));
    let number = 1;
    while (ids.has(`${prefix}-${number}`)) number += 1;
    return `${prefix}-${number}`;
  }

  function commitDiagram(candidate, status) {
    requireValidBubbleDiagram(candidate);
    if (typeof pushUndoState === "function") pushUndoState();
    plan.bubbleDiagram = candidate;
    persistPlan();
    showSaveStatus(status);
    render();
  }

  function createBubble(point) {
    const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
    const bubble = normalizeBubble({
      id: nextId("bubble", candidate.bubbles),
      name: "New Space",
      type: "space",
      size: null,
      quantity: null,
      position: point,
      metadata: {}
    });
    candidate.bubbles.push(bubble);
    selectedBubbleId = bubble.id;
    selectedConnectorId = null;
    commitDiagram(candidate, "Bubble added");
    requestAnimationFrame(() => startInlineEdit(bubble.id, "name"));
  }

  function displayUnit(unit) {
    return unit === "sqm" ? "㎡" : unit;
  }

  function pathGeometry(from, to) {
    const dx = to.position.x - from.position.x;
    const dy = to.position.y - from.position.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const fromRadius = diameter(from) / 2;
    const toRadius = diameter(to) / 2;
    let start;
    let end;
    if (horizontal) {
      const direction = dx >= 0 ? 1 : -1;
      start = { x: from.position.x + fromRadius * direction, y: from.position.y };
      end = { x: to.position.x - toRadius * direction, y: to.position.y };
      const bend = Math.max(40, Math.abs(end.x - start.x) * 0.45);
      return { start, end, d: `M ${start.x} ${start.y} C ${start.x + bend * direction} ${start.y}, ${end.x - bend * direction} ${end.y}, ${end.x} ${end.y}` };
    }
    const direction = dy >= 0 ? 1 : -1;
    start = { x: from.position.x, y: from.position.y + fromRadius * direction };
    end = { x: to.position.x, y: to.position.y - toRadius * direction };
    const bend = Math.max(40, Math.abs(end.y - start.y) * 0.45);
    return { start, end, d: `M ${start.x} ${start.y} C ${start.x} ${start.y + bend * direction}, ${end.x} ${end.y - bend * direction}, ${end.x} ${end.y}` };
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function renderConnectors() {
    connectorLayer.replaceChildren();
    const byId = new Map(plan.bubbleDiagram.bubbles.map((bubble) => [bubble.id, bubble]));
    plan.bubbleDiagram.connectors.forEach((connector) => {
      const from = byId.get(connector.fromBubbleId);
      const to = byId.get(connector.toBubbleId);
      if (!from || !to) return;
      const geometry = pathGeometry(from, to);
      const hit = svgElement("path", { d: geometry.d, class: "bubble-wire-hit", "data-connector-id": connector.id, "data-testid": `connector-${connector.id}` });
      hit.addEventListener("click", (event) => openConnectorPopover(connector.id, event));
      const wire = svgElement("path", { d: geometry.d, class: `bubble-wire relation-${connector.relationType} priority-${connector.priority}${selectedConnectorId === connector.id ? " is-selected" : ""}`, "data-wire-id": connector.id });
      connectorLayer.append(wire, hit);
      if (connector.relationType === "separate") {
        const marker = svgElement("text", { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 + 5, class: "wire-break" });
        marker.textContent = "×";
        connectorLayer.append(marker);
      }
    });
    if (pointerAction && pointerAction.kind === "connect") {
      const source = byId.get(pointerAction.sourceId);
      if (source) connectorLayer.append(svgElement("path", { d: pathGeometry(source, { position: pointerAction.point, size: { value: 1 } }).d, class: "bubble-wire-preview" }));
    }
  }

  function renderBubbles() {
    bubbleLayer.replaceChildren();
    plan.bubbleDiagram.bubbles.forEach((bubble) => {
      const node = document.createElement("div");
      node.className = `bubble-node${selectedBubbleId === bubble.id ? " is-selected" : ""}${pointerAction && pointerAction.targetId === bubble.id ? " is-target" : ""}`;
      node.dataset.bubbleId = bubble.id;
      node.dataset.testid = `bubble-${bubble.id}`;
      const size = diameter(bubble);
      Object.assign(node.style, { left: `${bubble.position.x}px`, top: `${bubble.position.y}px`, width: `${size}px`, height: `${size}px` });
      const selected = selectedBubbleId === bubble.id;
      const values = [
        ["name", bubble.name, "bubble-name"],
        ["size", bubble.size === null ? "+ Area" : `${bubble.size.value}${displayUnit(bubble.size.unit)}`, "bubble-size"],
        ["quantity", bubble.quantity === null ? "+ Qty" : `×${bubble.quantity}`, "bubble-quantity"]
      ].filter(([field]) => field === "name" || selected || bubble[field] !== null);
      values.forEach(([field, text, className]) => {
        const value = document.createElement("div");
        value.className = `bubble-value ${className}`;
        value.dataset.field = field;
        value.dataset.testid = `bubble-${bubble.id}-${field}`;
        value.textContent = text;
        value.addEventListener("dblclick", (event) => { event.stopPropagation(); startInlineEdit(bubble.id, field); });
        node.append(value);
      });
      node.addEventListener("pointerdown", (event) => startBubbleDrag(event, bubble));
      node.addEventListener("click", (event) => { event.stopPropagation(); selectBubble(bubble.id); });
      if (selectedBubbleId === bubble.id) {
        ["top", "right", "bottom", "left"].forEach((side) => {
          const port = document.createElement("button");
          port.type = "button";
          port.className = "bubble-port";
          port.dataset.side = side;
          port.dataset.testid = `bubble-port-${side}`;
          port.setAttribute("aria-label", `Connect from ${side}`);
          port.addEventListener("pointerdown", (event) => startConnection(event, bubble.id));
          node.append(port);
        });
      }
      bubbleLayer.append(node);
    });
  }

  function render() {
    scene.style.transform = `translate(${editorView.panX}px, ${editorView.panY}px) scale(${editorView.zoom})`;
    zoomReadout.textContent = `${Math.round(editorView.zoom * 100)}%`;
    renderConnectors();
    renderBubbles();
  }

  function selectBubble(id) {
    if (selectedBubbleId === id && selectedConnectorId === null) return;
    selectedBubbleId = id;
    selectedConnectorId = null;
    closePopover();
    render();
  }

  function startBubbleDrag(event, bubble) {
    if (event.button !== 0 || event.target.closest(".bubble-port") || event.target.closest(".bubble-inline-input")) return;
    event.preventDefault();
    event.stopPropagation();
    const changedSelection = selectedBubbleId !== bubble.id || selectedConnectorId !== null;
    selectedBubbleId = bubble.id;
    selectedConnectorId = null;
    const point = worldPoint(event.clientX, event.clientY);
    pointerAction = { kind: "bubble", id: bubble.id, offsetX: point.x - bubble.position.x, offsetY: point.y - bubble.position.y, moved: false, undoCaptured: false };
    if (changedSelection) render();
  }

  function startConnection(event, sourceId) {
    event.preventDefault();
    event.stopPropagation();
    pointerAction = { kind: "connect", sourceId, point: worldPoint(event.clientX, event.clientY), targetId: null };
    render();
  }

  function updatePointer(event) {
    if (!pointerAction) return;
    if (pointerAction.kind === "bubble") {
      const bubble = plan.bubbleDiagram.bubbles.find((item) => item.id === pointerAction.id);
      if (!bubble) return;
      const point = worldPoint(event.clientX, event.clientY);
      const position = { x: point.x - pointerAction.offsetX, y: point.y - pointerAction.offsetY };
      if (position.x === bubble.position.x && position.y === bubble.position.y) return;
      if (!pointerAction.undoCaptured && typeof pushUndoState === "function") {
        pushUndoState();
        pointerAction.undoCaptured = true;
      }
      bubble.position = position;
      pointerAction.moved = true;
    } else if (pointerAction.kind === "connect") {
      pointerAction.point = worldPoint(event.clientX, event.clientY);
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const node = target && target.closest(".bubble-node");
      pointerAction.targetId = node && node.dataset.bubbleId !== pointerAction.sourceId ? node.dataset.bubbleId : null;
    } else if (pointerAction.kind === "pan") {
      editorView.panX = pointerAction.panX + event.clientX - pointerAction.clientX;
      editorView.panY = pointerAction.panY + event.clientY - pointerAction.clientY;
    }
    render();
  }

  function endPointer() {
    if (!pointerAction) return;
    const action = pointerAction;
    pointerAction = null;
    if (action.kind === "bubble" && action.moved) { persistPlan(); render(); }
    if (action.kind === "connect" && action.targetId) {
      const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
      candidate.connectors.push(normalizeConnector({
        id: nextId("connector", candidate.connectors),
        fromBubbleId: action.sourceId,
        toBubbleId: action.targetId,
        relationType: "adjacent",
        priority: "preferred",
        direction: null,
        metadata: {}
      }));
      commitDiagram(candidate, "Connector added");
    } else if (action.kind !== "bubble") render();
  }

  function startInlineEdit(id, field) {
    const bubble = plan.bubbleDiagram.bubbles.find((item) => item.id === id);
    const value = bubbleLayer.querySelector(`[data-bubble-id="${CSS.escape(id)}"] [data-field="${field}"]`);
    if (!bubble || !value) return;
    const input = document.createElement("input");
    input.className = "bubble-inline-input";
    input.dataset.testid = `bubble-edit-${field}`;
    input.value = field === "name" ? bubble.name : field === "size" ? bubble.size && bubble.size.value : bubble.quantity;
    value.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (commit) => {
      if (finished || !input.isConnected) return;
      finished = true;
      if (commit) {
        const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
        const edited = candidate.bubbles.find((item) => item.id === id);
        const currentValue = field === "name" ? edited.name : field === "size" ? edited.size && edited.size.value : edited.quantity;
        const trimmed = input.value.trim();
        const nextValue = field === "name" ? trimmed : trimmed === "" ? null : Number(trimmed);
        if (Object.is(nextValue, currentValue)) {
          render();
          return;
        }
        if (field === "name") edited.name = nextValue;
        else if (field === "size") edited.size = nextValue === null ? null : { value: nextValue, unit: edited.size === null ? "sqm" : edited.size.unit };
        else edited.quantity = nextValue;
        try { commitDiagram(candidate, "Bubble updated"); } catch (error) { render(); showSaveStatus("Invalid Bubble value"); }
      } else render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
      event.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }

  function openConnectorPopover(id, event) {
    event.stopPropagation();
    selectedConnectorId = id;
    selectedBubbleId = null;
    const connector = plan.bubbleDiagram.connectors.find((item) => item.id === id);
    if (!connector) return;
    popover.innerHTML = `<label>Relation<select data-testid="connector-relation"><option value="adjacent">Adjacent</option><option value="near">Near</option><option value="separate">Separate</option></select></label><button type="button" class="delete-connector" data-testid="delete-connector">Delete Connector</button>`;
    popover.querySelector("[data-testid='connector-relation']").value = connector.relationType;
    const rect = workspace.getBoundingClientRect();
    popover.style.left = `${Math.min(rect.width - 205, Math.max(10, event.clientX - rect.left + 8))}px`;
    popover.style.top = `${Math.min(rect.height - 175, Math.max(10, event.clientY - rect.top + 8))}px`;
    popover.hidden = false;
    popover.querySelectorAll("select").forEach((select) => select.addEventListener("change", () => {
      const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
      const edited = candidate.connectors.find((item) => item.id === id);
      edited.relationType = popover.querySelector("[data-testid='connector-relation']").value;
      commitDiagram(candidate, "Connector updated");
    }));
    popover.querySelector(".delete-connector").addEventListener("click", () => {
      const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
      candidate.connectors = candidate.connectors.filter((item) => item.id !== id);
      selectedConnectorId = null;
      commitDiagram(candidate, "Connector removed");
      closePopover();
    });
    render();
  }

  function closePopover() { popover.hidden = true; }

  function removeSelectedBubble() {
    if (!selectedBubbleId) return;
    const candidate = cloneBubbleDiagram(plan.bubbleDiagram);
    candidate.bubbles = candidate.bubbles.filter((bubble) => bubble.id !== selectedBubbleId);
    candidate.connectors = candidate.connectors.filter((connector) => connector.fromBubbleId !== selectedBubbleId && connector.toBubbleId !== selectedBubbleId);
    selectedBubbleId = null;
    commitDiagram(candidate, "Bubble removed");
  }

  function setMode(nextMode) {
    mode = nextMode;
    editorMode = nextMode;
    if (reviewModeActive) reviewModeActive = false;
    document.body.classList.remove("review-mode");
    const bubbleMode = mode === "bubble";
    document.body.classList.toggle("bubble-mode", bubbleMode);
    workspace.hidden = !bubbleMode;
    document.getElementById("bubbleModeButton").classList.toggle("is-active", bubbleMode);
    document.getElementById("blockModeButton").classList.toggle("is-active", !bubbleMode);
    document.getElementById("bubbleModeButton").setAttribute("aria-pressed", String(bubbleMode));
    window.dispatchEvent(new CustomEvent("blockplan-mode-change"));
    document.getElementById("blockModeButton").setAttribute("aria-pressed", String(!bubbleMode));
    if (bubbleMode) {
      if (typeof setUnderlaySelected === "function") setUnderlaySelected(false);
      if (typeof window.clearBlockPlanInteractionState === "function") window.clearBlockPlanInteractionState();
      render();
    }
    else { selectedBubbleId = null; closePopover(); resizeCanvas(); draw(); }
  }

  document.getElementById("bubbleModeButton").addEventListener("click", () => setMode("bubble"));
  document.getElementById("blockModeButton").addEventListener("click", () => setMode("block"));
  document.getElementById("addBubbleButton").addEventListener("click", () => {
    const rect = workspace.getBoundingClientRect();
    createBubble(worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  });
  workspace.addEventListener("dblclick", (event) => {
    if (event.target === workspace || event.target === scene || event.target === bubbleLayer || event.target === connectorLayer) createBubble(worldPoint(event.clientX, event.clientY));
  });
  workspace.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".bubble-node, .bubble-wire-hit, .connector-popover, .add-bubble-button")) return;
    selectedBubbleId = null;
    selectedConnectorId = null;
    closePopover();
    if (event.button === 1 || (event.button === 0 && spaceDown)) {
      event.preventDefault();
      pointerAction = { kind: "pan", clientX: event.clientX, clientY: event.clientY, panX: editorView.panX, panY: editorView.panY };
    }
    render();
  });
  workspace.addEventListener("wheel", (event) => {
    event.preventDefault();
    const before = worldPoint(event.clientX, event.clientY);
    editorView.zoom = clamp(editorView.zoom * Math.exp(-event.deltaY * 0.001), 0.35, 2.5);
    const rect = workspace.getBoundingClientRect();
    editorView.panX = event.clientX - rect.left - before.x * editorView.zoom;
    editorView.panY = event.clientY - rect.top - before.y * editorView.zoom;
    render();
  }, { passive: false });
  window.addEventListener("pointermove", updatePointer);
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("keydown", (event) => {
    if (mode !== "bubble" || event.target.matches("input, select")) return;
    if (event.code === "Space") { event.preventDefault(); spaceDown = true; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelectedBubble(); }
    if (event.key === "Escape") { pointerAction = null; selectedBubbleId = null; selectedConnectorId = null; closePopover(); render(); }
  });
  window.addEventListener("keyup", (event) => { if (event.code === "Space") spaceDown = false; });
  window.addEventListener("resize", () => { if (mode === "bubble") render(); });
  window.addEventListener("click", (event) => { if (!popover.hidden && !event.target.closest(".connector-popover") && !event.target.closest(".bubble-wire-hit")) closePopover(); });

  window.refreshBubbleEditor = function refreshBubbleEditor() {
    if (selectedBubbleId && !plan.bubbleDiagram.bubbles.some((bubble) => bubble.id === selectedBubbleId)) selectedBubbleId = null;
    if (selectedConnectorId && !plan.bubbleDiagram.connectors.some((connector) => connector.id === selectedConnectorId)) selectedConnectorId = null;
    closePopover();
    render();
  };
  window.setBlockPlanEditorMode = setMode;
})();
