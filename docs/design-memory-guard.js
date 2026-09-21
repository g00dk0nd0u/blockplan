"use strict";

(function installDesignMemoryGuards() {
  function assertRawMemoryShape(source) {
    if (!source || source.memory === undefined) return;
    const memory = source.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) throw new Error("Design Memory must be an object");
    if (memory.version !== undefined && memory.version !== 1) throw new Error("Design Memory version must be 1");
    if (memory.items !== undefined && !Array.isArray(memory.items)) throw new Error("Design Memory items must be an array");
  }

  const baseNormalizePlan = normalizePlan;
  normalizePlan = function normalizePlanWithStrictMemoryInput(source) {
    assertRawMemoryShape(source);
    return baseNormalizePlan(source);
  };

  function validateConditionsShape(value) {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("applicableConditions must be an object");
    ["bubbleTypes", "relationTypes", "tags"].forEach((field) => {
      if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error(`applicableConditions.${field} must be an array`);
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
