"use strict";

(function installReviewUi() {
  const dock = document.getElementById("reviewDock");
  if (!dock) return;
  let selectedVariantId = null;
  let pendingDecision = null;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  function setReviewMode(active) {
    reviewModeActive = active;
    document.body.classList.toggle("review-mode", active);
    if (!active) pendingDecision = null;
    cancelCurrentOperation();
    refreshReviewDock();
  }

  function decisionEditor(variant, variants) {
    if (!pendingDecision) return "";
    const peers = variants.filter((item) => item.variantId !== variant.variantId && item.requirementsSnapshotId === variant.requirementsSnapshotId);
    return `<div class="review-editor" data-testid="review-editor">
      <strong>${escapeHtml(pendingDecision[0].toUpperCase() + pendingDecision.slice(1))} review</strong>
      <label>Good<textarea data-review-field="good" rows="2"></textarea></label>
      <label>Problems<textarea data-review-field="problems" rows="2"></textarea></label>
      <label>Next instruction<textarea data-review-field="nextInstructions" rows="2"></textarea></label>
      <label>Prefer current over…<select data-review-field="preferredOverVariantId"><option value="">None</option>${peers.map((item) => `<option value="${escapeHtml(item.variantId)}">${escapeHtml(item.variantId)}</option>`).join("")}</select></label>
      <div class="review-editor-actions"><button type="button" data-review-cancel>Cancel</button><button type="button" class="review-save" data-testid="review-save">Save Review</button></div>
      <p class="review-error" data-testid="review-error" hidden></p>
    </div>`;
  }

  function refreshReviewDock() {
    const variants = window.BlockPlanAPI.listVariants();
    if (!Array.isArray(variants) || !variants.length || isBubbleEditorMode()) {
      dock.hidden = true;
      if (reviewModeActive && (!Array.isArray(variants) || !variants.length)) setReviewMode(false);
      return;
    }
    dock.hidden = false;
    if (!variants.some((variant) => variant.variantId === selectedVariantId)) selectedVariantId = variants[0].variantId;
    const selected = variants.find((variant) => variant.variantId === selectedVariantId);
    dock.innerHTML = `<div class="review-dock-row">
      <label>Variant <select data-testid="review-variant-select">${variants.map((variant) => `<option value="${escapeHtml(variant.variantId)}"${variant.variantId === selectedVariantId ? " selected" : ""}>${escapeHtml(variant.variantId)}</option>`).join("")}</select></label>
      <button type="button" data-testid="review-toggle">${reviewModeActive ? "Exit Review" : "Review"}</button>
    </div>
    ${reviewModeActive ? `<div class="review-target">Reviewing <strong>${escapeHtml(selected.variantId)}</strong></div><div class="review-decisions">${["accept", "iterate", "reject"].map((decision) => `<button type="button" data-decision="${decision}" data-testid="review-${decision}">${decision[0].toUpperCase() + decision.slice(1)}</button>`).join("")}</div>${decisionEditor(selected, variants)}` : ""}`;
  }

  dock.addEventListener("change", (event) => {
    if (!event.target.matches("[data-testid='review-variant-select']")) return;
    selectedVariantId = event.target.value;
    pendingDecision = null;
    window.BlockPlanAPI.activateVariant(selectedVariantId);
    refreshReviewDock();
  });

  dock.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-testid='review-toggle']");
    if (toggle) {
      if (!reviewModeActive) {
        const result = window.BlockPlanAPI.activateVariant(selectedVariantId);
        if (!result.ok) return;
      }
      setReviewMode(!reviewModeActive);
      return;
    }
    const decision = event.target.closest("[data-decision]");
    if (decision) {
      pendingDecision = decision.dataset.decision;
      refreshReviewDock();
      return;
    }
    if (event.target.closest("[data-review-cancel]")) {
      pendingDecision = null;
      refreshReviewDock();
      return;
    }
    if (event.target.closest("[data-testid='review-save']")) {
      const input = { variantId: selectedVariantId, decision: pendingDecision };
      dock.querySelectorAll("[data-review-field]").forEach((field) => { input[field.dataset.reviewField] = field.value; });
      const result = window.BlockPlanAPI.createReview(input);
      if (!result.ok) {
        const error = dock.querySelector("[data-testid='review-error']");
        error.textContent = result.error;
        error.hidden = false;
        return;
      }
      pendingDecision = null;
      refreshReviewDock();
    }
  });

  window.refreshReviewDock = refreshReviewDock;
  window.addEventListener("blockplan-mode-change", refreshReviewDock);
  refreshReviewDock();
})();
