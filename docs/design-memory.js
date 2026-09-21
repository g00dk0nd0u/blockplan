"use strict";

(function installDesignMemory() {
  const SCOPES = ["project", "domain", "designer"];
  const TYPES = ["hard-rule", "soft-preference", "observed-pattern", "rejected-pattern"];
  const STATUSES = ["candidate", "approved", "rejected"];
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  function emptyState() {
    return { version: 1, items: [] };
  }

  function textItems(value) {
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
    return items.map((item) => String(item).trim()).filter(Boolean);
  }

  function stringArray(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return value;
    return value.map((item) => typeof item === "string" ? item.trim() : item);
  }

  function normalizeConditions(source) {
    const input = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    return {
      bubbleTypes: textItems(input.bubbleTypes),
      relationTypes: textItems(input.relationTypes),
      tags: textItems(input.tags)
    };
  }

  function normalizeItem(source) {
    const item = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    return {
      memoryId: item.memoryId,
      scope: item.scope,
      scopeKey: item.scopeKey == null || item.scopeKey === "" ? null : String(item.scopeKey).trim(),
      type: item.type,
      statement: typeof item.statement === "string" ? item.statement.trim() : item.statement,
      applicableConditions: normalizeConditions(item.applicableConditions),
      exceptions: textItems(item.exceptions),
      strength: item.strength === undefined ? 0.5 : Number(item.strength),
      evidenceReviewIds: stringArray(item.evidenceReviewIds),
      status: item.status === undefined ? "candidate" : item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  function normalizeState(source) {
    const state = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    return {
      version: 1,
      items: Array.isArray(state.items) ? state.items.map(normalizeItem) : []
    };
  }

  function requireValidConditions(conditions, memoryId) {
    if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) throw new Error(`Invalid applicableConditions: ${memoryId}`);
    ["bubbleTypes", "relationTypes", "tags"].forEach((field) => {
      if (!Array.isArray(conditions[field]) || conditions[field].some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Invalid applicableConditions.${field}: ${memoryId}`);
      }
    });
  }

  function requireValidState(state, reviewState) {
    if (!state || state.version !== 1 || !Array.isArray(state.items)) throw new Error("Invalid Design Memory state");
    const reviewIds = new Set((reviewState && Array.isArray(reviewState.reviews) ? reviewState.reviews : []).map((review) => review.reviewId));
    const memoryIds = new Set();
    state.items.forEach((item) => {
      if (!item || typeof item.memoryId !== "string" || !item.memoryId.trim()) throw new Error("Every Memory item must have an id");
      if (memoryIds.has(item.memoryId)) throw new Error(`Duplicate memoryId: ${item.memoryId}`);
      memoryIds.add(item.memoryId);
      if (!SCOPES.includes(item.scope)) throw new Error(`Invalid Memory scope: ${item.memoryId}`);
      if (item.scopeKey !== null && (typeof item.scopeKey !== "string" || !item.scopeKey.trim())) throw new Error(`Invalid Memory scopeKey: ${item.memoryId}`);
      if (!TYPES.includes(item.type)) throw new Error(`Invalid Memory type: ${item.memoryId}`);
      if (typeof item.statement !== "string" || !item.statement.trim()) throw new Error(`Memory statement is required: ${item.memoryId}`);
      requireValidConditions(item.applicableConditions, item.memoryId);
      if (!Array.isArray(item.exceptions) || item.exceptions.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`Invalid Memory exceptions: ${item.memoryId}`);
      if (!Number.isFinite(item.strength) || item.strength < 0 || item.strength > 1) throw new Error(`Memory strength must be between 0 and 1: ${item.memoryId}`);
      if (!Array.isArray(item.evidenceReviewIds) || !item.evidenceReviewIds.length) throw new Error(`Memory evidenceReviewIds are required: ${item.memoryId}`);
      const evidence = new Set();
      item.evidenceReviewIds.forEach((reviewId) => {
        if (typeof reviewId !== "string" || !reviewId.trim()) throw new Error(`Invalid evidenceReviewId: ${item.memoryId}`);
        if (evidence.has(reviewId)) throw new Error(`Duplicate evidenceReviewId: ${reviewId}`);
        evidence.add(reviewId);
        if (!reviewIds.has(reviewId)) throw new Error(`Unknown evidenceReviewId: ${reviewId}`);
      });
      if (!STATUSES.includes(item.status)) throw new Error(`Invalid Memory status: ${item.memoryId}`);
      if (typeof item.createdAt !== "string" || !item.createdAt.trim() || !Number.isFinite(Date.parse(item.createdAt))) throw new Error(`Invalid Memory createdAt: ${item.memoryId}`);
      if (typeof item.updatedAt !== "string" || !item.updatedAt.trim() || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error(`Invalid Memory updatedAt: ${item.memoryId}`);
    });
    return state;
  }

  function nextMemoryId() {
    const used = new Set(plan.memory.items.map((item) => item.memoryId));
    let index = 1;
    while (used.has(`memory-${index}`)) index += 1;
    return `memory-${index}`;
  }

  function findMemory(memoryId) {
    const id = String(memoryId || "").trim();
    const item = plan.memory.items.find((entry) => entry.memoryId === id);
    if (!item) throw new Error(`Unknown memoryId: ${id}`);
    return item;
  }

  function success(payload = {}) {
    return { ok: true, ...payload };
  }

  function failure(error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  function syncMemory(status) {
    requireValidState(plan.memory, plan.review);
    persistPlan();
    if (typeof window.refreshMemoryDock === "function") window.refreshMemoryDock();
    if (status) showSaveStatus(status);
  }

  function contextValues(context) {
    const normalized = context && typeof context === "object" && !Array.isArray(context) ? context : {};
    let snapshot = normalized.requirementsSnapshot || null;
    if (!snapshot && normalized.requirementsSnapshotId) {
      snapshot = plan.generation.requirementsSnapshots.find((item) => item.requirementsSnapshotId === normalized.requirementsSnapshotId) || null;
    }
    const bubbleTypes = new Set(textItems(normalized.bubbleTypes));
    const relationTypes = new Set(textItems(normalized.relationTypes));
    const tags = new Set(textItems(normalized.tags));
    if (snapshot) {
      (snapshot.bubbles || []).forEach((bubble) => { if (bubble.type) bubbleTypes.add(String(bubble.type)); });
      (snapshot.connectors || []).forEach((connector) => { if (connector.relationType) relationTypes.add(String(connector.relationType)); });
    }
    return {
      projectKey: normalized.projectKey || "current-project",
      domainKey: normalized.domainKey || null,
      designerKey: normalized.designerKey || null,
      bubbleTypes,
      relationTypes,
      tags
    };
  }

  function hasOverlap(requiredValues, available) {
    return !requiredValues.length || requiredValues.some((value) => available.has(value));
  }

  function relevantMemory(context = {}) {
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("Memory context must be an object");
    const values = contextValues(context);
    return plan.memory.items
      .filter((item) => item.status === "approved")
      .filter((item) => {
        const key = item.scope === "project" ? values.projectKey : item.scope === "domain" ? values.domainKey : values.designerKey;
        if (item.scopeKey !== null && item.scopeKey !== key) return false;
        const conditions = item.applicableConditions;
        return hasOverlap(conditions.bubbleTypes, values.bubbleTypes)
          && hasOverlap(conditions.relationTypes, values.relationTypes)
          && hasOverlap(conditions.tags, values.tags);
      })
      .sort((a, b) => b.strength - a.strength || a.memoryId.localeCompare(b.memoryId))
      .map(clone);
  }

  window.MemoryModel = { clone, emptyState, normalizeState, requireValidState, relevantMemory: (context) => clone(relevantMemory(context)) };

  const baseClonePlan = clonePlan;
  clonePlan = function clonePlanWithMemory(source) {
    const cloned = baseClonePlan(source);
    cloned.memory = normalizeState(source && source.memory);
    return cloned;
  };

  const baseNormalizePlan = normalizePlan;
  normalizePlan = function normalizePlanWithMemory(source) {
    const normalized = baseNormalizePlan(source);
    normalized.memory = normalizeState(source && source.memory);
    requireValidState(normalized.memory, normalized.review);
    return normalized;
  };

  (function restoreMemoryAfterAppSetup() {
    plan.memory = emptyState();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      const restored = normalizeState(parsed.memory);
      requireValidState(restored, plan.review);
      plan.memory = restored;
    } catch (error) {
      plan.memory = emptyState();
      console.warn("Design Memory restore failed", error);
    }
  })();

  const api = window.BlockPlanAPI;
  if (!api) return;

  api.proposeMemoryFromReviews = function proposeMemoryFromReviews(input) {
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Memory proposal must be an object");
      const now = input.createdAt || new Date().toISOString();
      const item = normalizeItem({
        memoryId: input.memoryId || nextMemoryId(),
        scope: input.scope,
        scopeKey: input.scopeKey,
        type: input.type,
        statement: input.statement,
        applicableConditions: input.applicableConditions,
        exceptions: input.exceptions,
        strength: input.strength,
        evidenceReviewIds: input.evidenceReviewIds,
        status: "candidate",
        createdAt: now,
        updatedAt: input.updatedAt || now
      });
      const candidateState = { version: 1, items: [...plan.memory.items, item] };
      requireValidState(candidateState, plan.review);
      plan.memory.items.push(item);
      syncMemory("Memory candidate added");
      return success({ memory: clone(item) });
    } catch (error) { return failure(error); }
  };

  api.listMemory = function listMemory(filter = {}) {
    try {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("Memory filter must be an object");
      return clone(plan.memory.items.filter((item) =>
        (filter.status === undefined || item.status === filter.status)
        && (filter.scope === undefined || item.scope === filter.scope)
        && (filter.type === undefined || item.type === filter.type)
        && (filter.evidenceReviewId === undefined || item.evidenceReviewIds.includes(filter.evidenceReviewId))));
    } catch (error) { return failure(error); }
  };

  api.getMemory = function getMemory(memoryId) {
    try { return clone(findMemory(memoryId)); } catch (error) { return failure(error); }
  };

  api.updateMemoryCandidate = function updateMemoryCandidate(memoryId, patch) {
    try {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Memory patch must be an object");
      const current = findMemory(memoryId);
      if (current.status !== "candidate") throw new Error("Only candidate Memory can be edited");
      const allowed = ["scope", "scopeKey", "type", "statement", "applicableConditions", "exceptions", "strength"];
      const nextSource = clone(current);
      allowed.forEach((field) => { if (patch[field] !== undefined) nextSource[field] = patch[field]; });
      nextSource.updatedAt = new Date().toISOString();
      const next = normalizeItem(nextSource);
      const candidateState = { version: 1, items: plan.memory.items.map((item) => item.memoryId === current.memoryId ? next : item) };
      requireValidState(candidateState, plan.review);
      plan.memory = candidateState;
      syncMemory("Memory candidate updated");
      return success({ memory: clone(next) });
    } catch (error) { return failure(error); }
  };

  function transitionMemory(memoryId, status) {
    const current = findMemory(memoryId);
    if (current.status !== "candidate") throw new Error("Only candidate Memory can change status");
    const next = { ...clone(current), status, updatedAt: new Date().toISOString() };
    const candidateState = { version: 1, items: plan.memory.items.map((item) => item.memoryId === current.memoryId ? next : item) };
    requireValidState(candidateState, plan.review);
    plan.memory = candidateState;
    syncMemory(status === "approved" ? "Memory approved" : "Memory rejected");
    return clone(next);
  }

  api.approveMemory = function approveMemory(memoryId) {
    try { return success({ memory: transitionMemory(memoryId, "approved") }); } catch (error) { return failure(error); }
  };

  api.rejectMemory = function rejectMemory(memoryId) {
    try { return success({ memory: transitionMemory(memoryId, "rejected") }); } catch (error) { return failure(error); }
  };

  api.getRelevantMemory = function getRelevantMemory(context = {}) {
    try { return clone(relevantMemory(context)); } catch (error) { return failure(error); }
  };

  const baseGetGenerationContext = api.getGenerationContext.bind(api);
  api.getGenerationContext = function getGenerationContextWithMemory(requirementsSnapshotId, memoryContext = {}) {
    const context = baseGetGenerationContext(requirementsSnapshotId);
    if (context && context.ok === false) return context;
    return {
      ...context,
      relevantMemory: clone(relevantMemory({ ...memoryContext, requirementsSnapshotId }))
    };
  };

  const baseGetIterationContext = api.getIterationContext.bind(api);
  api.getIterationContext = function getIterationContextWithMemory(variantId, memoryContext = {}) {
    const context = baseGetIterationContext(variantId);
    if (context && context.ok === false) return context;
    return {
      ...context,
      relevantMemory: clone(relevantMemory({ ...memoryContext, requirementsSnapshotId: context.variant.requirementsSnapshotId }))
    };
  };

  const baseSetPlan = api.setPlan.bind(api);
  api.setPlan = function setPlanWithMemory(input) {
    const result = baseSetPlan(input);
    if (result && result.ok && typeof window.refreshMemoryDock === "function") window.refreshMemoryDock();
    return result;
  };

  const dock = document.createElement("section");
  dock.id = "memoryDock";
  dock.className = "memory-dock";
  dock.dataset.testid = "memory-dock";
  dock.setAttribute("aria-label", "Design Memory candidates");
  dock.hidden = true;
  const canvasPanel = document.querySelector(".canvas-panel");
  if (canvasPanel) canvasPanel.appendChild(dock);

  const style = document.createElement("style");
  style.textContent = `
    .memory-dock{position:absolute;left:14px;top:14px;z-index:6;max-width:320px;padding:8px;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--panel) 94%,transparent);box-shadow:var(--shadow);font-size:12px}
    .memory-dock-row,.memory-actions{display:flex;align-items:center;gap:6px;justify-content:space-between}
    .memory-dock label{display:grid;gap:2px}.memory-dock textarea,.memory-dock input,.memory-dock select{box-sizing:border-box;font:inherit;max-width:100%;width:100%}
    .memory-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}.memory-evidence{color:var(--muted);margin:6px 0}.memory-error{color:#9a3028;margin:6px 0 0}
    body.review-mode .memory-dock{display:none!important}
  `;
  document.head.appendChild(style);

  let selectedMemoryId = null;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  function refreshMemoryDock() {
    if (!dock) return;
    const candidates = plan.memory.items.filter((item) => item.status === "candidate");
    if (!candidates.length || (typeof isBubbleEditorMode === "function" && isBubbleEditorMode())) {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;
    if (!candidates.some((item) => item.memoryId === selectedMemoryId)) selectedMemoryId = candidates[0].memoryId;
    const selected = candidates.find((item) => item.memoryId === selectedMemoryId);
    dock.innerHTML = `
      <div class="memory-dock-row"><strong>Memory candidate</strong><select data-memory-select>${candidates.map((item) => `<option value="${escapeHtml(item.memoryId)}"${item.memoryId === selected.memoryId ? " selected" : ""}>${escapeHtml(item.memoryId)}</option>`).join("")}</select></div>
      <label>Statement<textarea data-memory-field="statement" rows="3">${escapeHtml(selected.statement)}</textarea></label>
      <div class="memory-grid">
        <label>Scope<select data-memory-field="scope">${SCOPES.map((scope) => `<option value="${scope}"${scope === selected.scope ? " selected" : ""}>${scope}</option>`).join("")}</select></label>
        <label>Type<select data-memory-field="type">${TYPES.map((type) => `<option value="${type}"${type === selected.type ? " selected" : ""}>${type}</option>`).join("")}</select></label>
        <label>Scope key<input data-memory-field="scopeKey" value="${escapeHtml(selected.scopeKey || "")}"></label>
        <label>Strength<input data-memory-field="strength" type="number" min="0" max="1" step="0.1" value="${selected.strength}"></label>
      </div>
      <label>Exceptions<textarea data-memory-field="exceptions" rows="2">${escapeHtml(selected.exceptions.join("\n"))}</textarea></label>
      <p class="memory-evidence">Evidence: ${selected.evidenceReviewIds.map(escapeHtml).join(", ")}</p>
      <div class="memory-actions"><button type="button" data-memory-save>Save edit</button><button type="button" data-memory-reject>Reject</button><button type="button" data-memory-approve>Approve</button></div>
      <p class="memory-error" data-memory-error hidden></p>`;
  }

  function candidatePatch() {
    const patch = {};
    dock.querySelectorAll("[data-memory-field]").forEach((field) => {
      let value = field.value;
      if (field.dataset.memoryField === "strength") value = Number(value);
      if (field.dataset.memoryField === "exceptions") value = value.split(/\r?\n/);
      patch[field.dataset.memoryField] = value;
    });
    return patch;
  }

  function showDockError(message) {
    const error = dock.querySelector("[data-memory-error]");
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  }

  dock.addEventListener("change", (event) => {
    if (!event.target.matches("[data-memory-select]")) return;
    selectedMemoryId = event.target.value;
    refreshMemoryDock();
  });

  dock.addEventListener("click", (event) => {
    if (!selectedMemoryId) return;
    if (event.target.closest("[data-memory-save]")) {
      const result = api.updateMemoryCandidate(selectedMemoryId, candidatePatch());
      if (!result.ok) showDockError(result.error);
      return;
    }
    if (event.target.closest("[data-memory-reject]")) {
      const result = api.rejectMemory(selectedMemoryId);
      if (!result.ok) showDockError(result.error);
      return;
    }
    if (event.target.closest("[data-memory-approve]")) {
      const updated = api.updateMemoryCandidate(selectedMemoryId, candidatePatch());
      if (!updated.ok) { showDockError(updated.error); return; }
      const result = api.approveMemory(selectedMemoryId);
      if (!result.ok) showDockError(result.error);
    }
  });

  window.refreshMemoryDock = refreshMemoryDock;
  window.addEventListener("blockplan-mode-change", refreshMemoryDock);
  const bodyObserver = new MutationObserver(refreshMemoryDock);
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  refreshMemoryDock();
})();
