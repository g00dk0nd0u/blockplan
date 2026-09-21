"use strict";

(function installReviewModeGuards() {
  const protectedControlIds = ["clearButton", "loadJsonButton"];

  function reviewIsActive() {
    return typeof reviewModeActive !== "undefined" && reviewModeActive;
  }

  function syncProtectedControls() {
    const active = reviewIsActive();
    protectedControlIds.forEach((id) => {
      const control = document.getElementById(id);
      if (!control) return;
      control.disabled = active;
      control.setAttribute("aria-disabled", String(active));
    });
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (!reviewIsActive() || isEditingText()) return;
      const key = event.key.toLowerCase();
      const isUndo = (event.metaKey || event.ctrlKey) && key === "z";
      const isMutationShortcut = isUndo || event.key === "Delete" || event.key === "Backspace" || key === "g";
      if (!isMutationShortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showSaveStatus("Exit Review to edit");
    },
    true
  );

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (!reviewIsActive()) return;
      if (event.button === 1 || isSpaceDown) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!reviewIsActive()) return;
      const blockedControl = event.target.closest("#clearButton, #loadJsonButton");
      if (!blockedControl) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showSaveStatus("Exit Review to change plan");
    },
    true
  );

  if (loadJsonInput) {
    loadJsonInput.addEventListener(
      "change",
      (event) => {
        if (!reviewIsActive()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        event.target.value = "";
        showSaveStatus("Exit Review to load a plan");
      },
      true
    );
  }

  const observer = new MutationObserver(syncProtectedControls);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("blockplan-mode-change", syncProtectedControls);
  syncProtectedControls();
})();
