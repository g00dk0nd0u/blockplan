"use strict";

(function installDesignMemoryGuards() {
  function assertRawMemoryShape(source) {
    if (!source || source.memory === undefined) return;
    const memory = source.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) throw new Error("Design Memory must be an object");
    if (memory.version !== 1) throw new Error("Design Memory version must be 1");
    if (!Array.isArray(memory.items)) throw new Error("Design Memory items must be an array");
    memory.items.forEach((item, index) => {
      const label = item && typeof item.memoryId === "string" ? item.memoryId : `item ${index}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid Design Memory item: ${index}`);
      if (typeof item.memoryId !== "string" || !item.memoryId.trim()) throw new Error(`Invalid memoryId: ${label}`);
      if (typeof item.scope !== "string") throw new Error(`Invalid Memory scope: ${label}`);
      if (item.scopeKey !== null && (typeof item.scopeKey !== "string" || !item.scopeKey.trim())) throw new Error(`Invalid Memory scopeKey: ${label}`);
      if (typeof item.type !== "string") throw new Error(`Invalid Memory type: ${label}`);
      if (typeof item.statement !== "string" || !item.statement.trim()) throw new Error(`Memory statement is required: ${label}`);
      validateConditionsShape(item.applicableConditions, true);
      if (!Array.isArray(item.exceptions) || item.exceptions.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`Invalid Memory exceptions: ${label}`);
      if (typeof item.strength !== "number" || !Number.isFinite(item.strength)) throw new Error(`Invalid Memory strength: ${label}`);
      if (!Array.isArray(item.evidenceReviewIds)) throw new Error(`Invalid Memory evidenceReviewIds: ${label}`);
      if (typeof item.status !== "string") throw new Error(`Invalid Memory status: ${label}`);
      ["createdAt", "updatedAt"].forEach((field) => {
        if (typeof item[field] !== "string" || !item[field].trim() || !Number.isFinite(Date.parse(item[field]))) throw new Error(`Invalid Memory ${field}: ${label}`);
      });
    });
  }

  const baseNormalizePlan = normalizePlan;
  normalizePlan = function normalizePlanWithStrictMemoryInput(source) {
    assertRawMemoryShape(source);
    return baseNormalizePlan(source);
  };

  // app.js restores before this optional module is installed. Re-run that one
  // startup boundary through the strict validator so malformed Memory cannot
  // leave the rest of a saved plan partially restored.
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const source = JSON.parse(saved);
      if (source.memory !== undefined) plan = normalizePlan(source);
    }
  } catch (error) {
    plan = normalizePlan(defaultPlan);
    showSaveStatus("Saved plan unreadable");
    console.warn("Design Memory restore rejected", error);
  }

  function validateConditionsShape(value, requireAllFields = false) {
    if (value === undefined && !requireAllFields) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("applicableConditions must be an object");
    ["bubbleTypes", "relationTypes", "tags"].forEach((field) => {
      if ((requireAllFields || value[field] !== undefined) && !Array.isArray(value[field])) throw new Error(`applicableConditions.${field} must be an array`);
      if (Array.isArray(value[field]) && value[field].some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`applicableConditions.${field} must contain non-empty strings`);
    });
  }

  function propagateMemoryIntoUndoHistory() {
    if (typeof patchUndoStack === "undefined" || !Array.isArray(patchUndoStack)) return;
    patchUndoStack.forEach((serialized, index) => {
      try {
        const snapshot = JSON.parse(serialized);
        const snapshotPlan = snapshot.plan || snapshot;
        snapshotPlan.memory = JSON.parse(JSON.stringify(plan.memory));
        patchUndoStack[index] = JSON.stringify(snapshot);
      } catch (error) {
        console.warn("Design Memory undo-history sync failed", error);
      }
    });
  }

  const api = window.BlockPlanAPI;
  if (!api) return;

  const basePropose = api.proposeMemoryFromReviews.bind(api);
  api.proposeMemoryFromReviews = function proposeMemoryFromReviewsGuarded(input) {
    try {
      if (input && input.applicableConditions !== undefined) validateConditionsShape(input.applicableConditions);
      const normalizedInput = input && typeof input === "object" && !Array.isArray(input)
        ? { ...input, memoryId: typeof input.memoryId === "string" ? input.memoryId.trim() : input.memoryId }
        : input;
      const result = basePropose(normalizedInput);
      if (result && result.ok) propagateMemoryIntoUndoHistory();
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const baseUpdate = api.updateMemoryCandidate.bind(api);
  api.updateMemoryCandidate = function updateMemoryCandidateGuarded(memoryId, patch) {
    try {
      if (patch && patch.applicableConditions !== undefined) validateConditionsShape(patch.applicableConditions);
      const result = baseUpdate(memoryId, patch);
      if (result && result.ok) propagateMemoryIntoUndoHistory();
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  ["approveMemory", "rejectMemory"].forEach((method) => {
    const base = api[method].bind(api);
    api[method] = function guardedMemoryTransition(...args) {
      const result = base(...args);
      if (result && result.ok) propagateMemoryIntoUndoHistory();
      return result;
    };
  });

  const baseShowSaveStatus = showSaveStatus;
  showSaveStatus = function showSaveStatusWithMemoryRefresh(message) {
    baseShowSaveStatus(message);
    if (message === "JSON loaded") {
      if (typeof window.refreshMemoryDock === "function") window.refreshMemoryDock();
      if (typeof window.refreshReviewDock === "function") window.refreshReviewDock();
    }
  };
})();
