const dataCenter = {
  generationFrame: { version: 1, bounds: { x: 0, y: 0, width: 16, height: 12 } },
  bubbles: [
    { id: "hall", name: "Data Hall", type: "compute", size: { value: 4, unit: "sqm" }, quantity: 2, position: { x: 10, y: 20 } },
    { id: "electrical", name: "Electrical", type: "power", size: { value: 2, unit: "sqm" }, quantity: 1, position: { x: 30, y: 20 } },
    { id: "mechanical", name: "Mechanical", type: "cooling", size: { value: 2, unit: "sqm" }, quantity: 1, position: { x: 50, y: 20 } },
    { id: "mmr", name: "MMR", type: "communications", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 70, y: 20 } }
  ],
  connectors: [
    { id: "power-hall", fromBubbleId: "electrical", toBubbleId: "hall", relationType: "adjacent", priority: "required" },
    { id: "cooling-hall", fromBubbleId: "mechanical", toBubbleId: "hall", relationType: "near", priority: "preferred" },
    { id: "mmr-power", fromBubbleId: "mmr", toBubbleId: "electrical", relationType: "separate", priority: "required" }
  ],
  rulePack: { version: 1, id: "data-center-benchmark", rules: [
    { id: "hall-shape", kind: "compactness", selector: { bubbleIds: ["hall"] }, severity: "preferred", parameters: { minimumFillRatio: 0.8 } },
    { id: "hall-repeat", kind: "repeatability", selector: { types: ["compute"] }, severity: "preferred", parameters: { requireIdentical: true } },
    { id: "cooling-near", kind: "near-distance", selector: { bubbleIds: ["hall", "mechanical"] }, severity: "preferred", parameters: { maximumGridGap: 2 } }
  ] }
};

const office = {
  generationFrame: { version: 1, bounds: { x: 0, y: 0, width: 12, height: 10 } },
  bubbles: [
    { id: "work", name: "Work Area", type: "work", size: { value: 4, unit: "sqm" }, quantity: 1, position: { x: 10, y: 20 } },
    { id: "meeting", name: "Meeting", type: "collaboration", size: { value: 2, unit: "sqm" }, quantity: 1, position: { x: 30, y: 20 } },
    { id: "reception", name: "Reception", type: "arrival", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 50, y: 20 } },
    { id: "support", name: "Support", type: "support", size: { value: 1, unit: "sqm" }, quantity: 1, position: { x: 70, y: 20 } }
  ],
  connectors: [{ id: "meeting-work", fromBubbleId: "meeting", toBubbleId: "work", relationType: "adjacent", priority: "required" }],
  rulePack: { version: 1, id: "office-benchmark", rules: [
    { id: "work-area", kind: "area-tolerance", selector: { types: ["work"] }, severity: "required", parameters: { maxRelativeDeviation: 0.1 } },
    { id: "meeting-shape", kind: "aspect-ratio", selector: { bubbleIds: ["meeting"] }, severity: "preferred", parameters: { maximum: 2 } }
  ] }
};

module.exports = { dataCenter, office };
