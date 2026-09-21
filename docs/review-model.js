"use strict";

(function installReviewModel() {
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  function emptyState() {
    return { version: 1, reviews: [] };
  }

  function textItems(value) {
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
    return items.map((item) => String(item).trim()).filter(Boolean);
  }

  function normalizeState(source) {
    const state = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    return {
      version: 1,
      reviews: Array.isArray(state.reviews) ? state.reviews.map((review) => ({
        reviewId: review.reviewId,
        variantId: review.variantId,
        requirementsSnapshotId: review.requirementsSnapshotId,
        decision: review.decision,
        good: textItems(review.good),
        problems: textItems(review.problems),
        nextInstructions: textItems(review.nextInstructions),
        preferredOverVariantId: review.preferredOverVariantId == null ? null : review.preferredOverVariantId,
        createdAt: review.createdAt
      })) : []
    };
  }

  function requireValidState(state, generation) {
    const variants = new Map(generation.variants.map((variant) => [variant.variantId, variant]));
    const reviewIds = new Set();
    state.reviews.forEach((review) => {
      if (!review || typeof review.reviewId !== "string" || !review.reviewId.trim()) throw new Error("Every Review must have an id");
      if (reviewIds.has(review.reviewId)) throw new Error(`Duplicate reviewId: ${review.reviewId}`);
      reviewIds.add(review.reviewId);
      const variant = variants.get(review.variantId);
      if (!variant) throw new Error(`Unknown review variantId: ${review.variantId}`);
      if (review.requirementsSnapshotId !== variant.requirementsSnapshotId) throw new Error(`Review requirementsSnapshotId does not match Variant: ${review.reviewId}`);
      if (!["accept", "iterate", "reject"].includes(review.decision)) throw new Error(`Invalid Review decision: ${review.decision}`);
      [review.good, review.problems, review.nextInstructions].forEach((items) => {
        if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`Invalid Review feedback: ${review.reviewId}`);
      });
      if (review.preferredOverVariantId !== null) {
        const preferred = variants.get(review.preferredOverVariantId);
        if (!preferred) throw new Error(`Unknown preferredOverVariantId: ${review.preferredOverVariantId}`);
        if (preferred.variantId === variant.variantId) throw new Error("A Variant cannot be preferred over itself");
        if (preferred.requirementsSnapshotId !== variant.requirementsSnapshotId) throw new Error("Preferred Variant must use the same Requirements Snapshot");
      }
      if (typeof review.createdAt !== "string" || !review.createdAt.trim()) throw new Error(`Review createdAt is required: ${review.reviewId}`);
    });
    return state;
  }

  window.ReviewModel = { clone, emptyState, normalizeState, requireValidState, textItems };
})();
