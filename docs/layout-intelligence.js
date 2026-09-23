"use strict";

(function installLayoutIntelligence() {
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const RULE_KINDS = new Set(["area-tolerance", "aspect-ratio", "compactness", "near-distance", "repeatability"]);
  const SEVERITIES = new Set(["required", "preferred"]);

  function finite(value, path, options = {}) {
    const number = Number(value);
    if (!Number.isFinite(number) || (options.minimum !== undefined && number < options.minimum) || (options.maximum !== undefined && number > options.maximum)) {
      throw new Error(`${path} is invalid`);
    }
    return number;
  }

  function normalizeRulePack(source) {
    if (source == null) return null;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Rule Pack must be an object");
    if (source.version !== 1) throw new Error("Rule Pack version must be 1");
    if (typeof source.id !== "string" || !source.id.trim()) throw new Error("Rule Pack id is required");
    if (!Array.isArray(source.rules)) throw new Error("Rule Pack rules must be an array");
    const ruleIds = new Set();
    const rules = source.rules.map((sourceRule, index) => {
      const path = `Rule Pack rule ${index + 1}`;
      if (!sourceRule || typeof sourceRule !== "object" || Array.isArray(sourceRule)) throw new Error(`${path} must be an object`);
      const allowed = new Set(["id", "kind", "selector", "severity", "parameters"]);
      Object.keys(sourceRule).forEach((key) => { if (!allowed.has(key)) throw new Error(`${path} has unsupported field: ${key}`); });
      const id = typeof sourceRule.id === "string" ? sourceRule.id.trim() : "";
      if (!id || ruleIds.has(id)) throw new Error(`${path} id must be unique and non-empty`);
      ruleIds.add(id);
      if (!RULE_KINDS.has(sourceRule.kind)) throw new Error(`${path} has unsupported kind: ${sourceRule.kind}`);
      if (!SEVERITIES.has(sourceRule.severity)) throw new Error(`${path} severity must be required or preferred`);
      const selector = sourceRule.selector;
      if (!selector || typeof selector !== "object" || Array.isArray(selector)) throw new Error(`${path} selector must be an object`);
      const selectorKeys = Object.keys(selector);
      if (!selectorKeys.length || selectorKeys.some((key) => !["bubbleIds", "types"].includes(key))) throw new Error(`${path} selector must contain only bubbleIds and/or types`);
      const normalizedSelector = {};
      selectorKeys.sort().forEach((key) => {
        if (!Array.isArray(selector[key]) || !selector[key].length || selector[key].some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${path} selector.${key} must be a non-empty string array`);
        normalizedSelector[key] = [...new Set(selector[key].map((item) => item.trim()))].sort();
      });
      const parameters = sourceRule.parameters;
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error(`${path} parameters must be an object`);
      const normalizedParameters = {};
      const specs = {
        "area-tolerance": { required: ["maxRelativeDeviation"], allowed: ["maxRelativeDeviation"] },
        "aspect-ratio": { required: [], allowed: ["minimum", "maximum"] },
        compactness: { required: ["minimumFillRatio"], allowed: ["minimumFillRatio"] },
        "near-distance": { required: ["maximumGridGap"], allowed: ["maximumGridGap"] },
        repeatability: { required: [], allowed: ["requireIdentical"] }
      }[sourceRule.kind];
      const parameterKeys = Object.keys(parameters);
      if (parameterKeys.some((key) => !specs.allowed.includes(key)) || specs.required.some((key) => !parameterKeys.includes(key))) throw new Error(`${path} has invalid parameters`);
      if (sourceRule.kind === "repeatability") {
        if (parameters.requireIdentical !== undefined && typeof parameters.requireIdentical !== "boolean") throw new Error(`${path} parameters.requireIdentical must be boolean`);
        normalizedParameters.requireIdentical = parameters.requireIdentical === undefined ? true : parameters.requireIdentical;
      } else {
        parameterKeys.forEach((key) => { normalizedParameters[key] = finite(parameters[key], `${path} parameters.${key}`, { minimum: 0, maximum: key === "minimumFillRatio" ? 1 : undefined }); });
        if (sourceRule.kind === "aspect-ratio" && !parameterKeys.length) throw new Error(`${path} aspect-ratio requires minimum and/or maximum`);
        if (normalizedParameters.minimum !== undefined && normalizedParameters.maximum !== undefined && normalizedParameters.minimum > normalizedParameters.maximum) throw new Error(`${path} minimum exceeds maximum`);
      }
      return { id, kind: sourceRule.kind, selector: normalizedSelector, severity: sourceRule.severity, parameters: normalizedParameters };
    });
    return { version: 1, id: source.id.trim(), rules };
  }

  function requireValidRulePack(source) { return normalizeRulePack(source); }

  function buildLayoutProblem({ requirementsSnapshot, generationContext, relevantMemory = [], rulePack } = {}) {
    if (!requirementsSnapshot || typeof requirementsSnapshot !== "object") throw new Error("Requirements Snapshot is required");
    if (!generationContext || typeof generationContext !== "object" || Array.isArray(generationContext)) throw new Error("generationContext is required");
    const selectedRulePack = rulePack === undefined ? generationContext.rulePack : rulePack;
    return clone({
      version: 1,
      requirementsSnapshotId: requirementsSnapshot.requirementsSnapshotId,
      moduleSizeMm: generationContext.moduleSizeMm,
      categories: generationContext.categories || [],
      spaces: (requirementsSnapshot.bubbles || []).map((bubble) => ({ bubbleId: bubble.id, name: bubble.name, type: bubble.type, targetSize: bubble.size, quantity: bubble.quantity, metadata: bubble.metadata || {} })),
      relationships: (requirementsSnapshot.connectors || []).map((connector) => ({ connectorId: connector.id, fromBubbleId: connector.fromBubbleId, toBubbleId: connector.toBubbleId, relationType: connector.relationType, priority: connector.priority, direction: connector.direction, metadata: connector.metadata || {} })),
      relevantMemory: Array.isArray(relevantMemory) ? relevantMemory : [],
      rulePack: normalizeRulePack(selectedRulePack)
    });
  }

  function shapeSignature(keys) {
    const points = keys.map((key) => key.split(",").map(Number));
    const minX = Math.min(...points.map(([x]) => x));
    const minY = Math.min(...points.map(([, y]) => y));
    return points.map(([x, y]) => `${x - minX},${y - minY}`).sort().join(";");
  }

  function zoneMetric(zoneId, keys, moduleSizeMm) {
    const points = keys.map((key) => key.split(",").map(Number));
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    const widthCells = Math.max(...xs) - Math.min(...xs) + 1;
    const heightCells = Math.max(...ys) - Math.min(...ys) + 1;
    const occupied = new Set(keys);
    let perimeterEdgeCount = 0;
    points.forEach(([x, y]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { if (!occupied.has(`${x + dx},${y + dy}`)) perimeterEdgeCount += 1; }));
    return { zoneId, cellCount: keys.length, areaSqm: keys.length * Math.pow(moduleSizeMm / 1000, 2), widthCells, heightCells, aspectRatio: Math.max(widthCells, heightCells) / Math.min(widthCells, heightCells), boundingBoxFillRatio: keys.length / (widthCells * heightCells), perimeterEdgeCount, normalizedShapeSignature: shapeSignature(keys) };
  }

  function matches(rule, bubble) {
    return (!rule.selector.bubbleIds || rule.selector.bubbleIds.includes(bubble.id)) && (!rule.selector.types || rule.selector.types.includes(bubble.type));
  }

  function evaluateVariant(variant, requirementsSnapshot, options = {}) {
    const validation = clone(GenerationModel.validate(variant, requirementsSnapshot));
    const rulePack = normalizeRulePack(options.rulePack === undefined && options.layoutProblem ? options.layoutProblem.rulePack : options.rulePack);
    const zones = GenerationModel.zonesFor(variant.blockPlan.cells);
    const zoneMetrics = [...zones.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([zoneId, keys]) => zoneMetric(zoneId, keys, variant.blockPlan.moduleSizeMm));
    const zoneById = new Map(zoneMetrics.map((metric) => [metric.zoneId, metric]));
    const sizeByZone = new Map(validation.metrics.sizes.map((metric) => [metric.zoneId, metric]));
    const bubbleMetrics = (requirementsSnapshot.bubbles || []).map((bubble) => {
      const assignedZoneIds = Object.entries(variant.blockPlan.zoneAssignments).filter(([, assignment]) => assignment.bubbleId === bubble.id).map(([zoneId]) => zoneId).sort();
      const shapes = assignedZoneIds.map((zoneId) => zoneById.get(zoneId)).filter(Boolean);
      const signatures = [...new Set(shapes.map((metric) => metric.normalizedShapeSignature))].sort();
      return { bubbleId: bubble.id, quantity: bubble.quantity, assignedZoneIds, targetAreaSqm: sizeByZone.get(assignedZoneIds[0])?.targetSqm ?? null, actualAreasSqm: assignedZoneIds.map((zoneId) => sizeByZone.get(zoneId)?.actualSqm ?? null), relativeAreaDeviations: assignedZoneIds.map((zoneId) => { const item = sizeByZone.get(zoneId); return item && item.targetSqm ? Math.abs(item.actualSqm - item.targetSqm) / item.targetSqm : null; }), repeatability: { zoneCount: shapes.length, distinctShapeCount: signatures.length, identicalShapes: shapes.length < 2 || signatures.length === 1, shapeSignatures: signatures } };
    });
    const bubbleById = new Map((requirementsSnapshot.bubbles || []).map((bubble) => [bubble.id, bubble]));
    const relationshipById = new Map(validation.metrics.relationships.map((metric) => [metric.connectorId, metric]));
    const criticFindings = [];
    function finding(rule, code, values) { criticFindings.push({ code, severity: rule.severity, ruleId: rule.id, ...values }); }
    (rulePack ? rulePack.rules : []).forEach((rule) => {
      if (rule.kind === "near-distance") {
        (requirementsSnapshot.connectors || []).filter((connector) => connector.relationType === "near" && matches(rule, bubbleById.get(connector.fromBubbleId)) && matches(rule, bubbleById.get(connector.toBubbleId))).forEach((connector) => {
          const metric = relationshipById.get(connector.id);
          if (metric && metric.evaluationStatus === "evaluated" && metric.minimumGridGap > rule.parameters.maximumGridGap) finding(rule, "near_distance_above_max", { connectorId: connector.id, actual: metric.minimumGridGap, threshold: rule.parameters.maximumGridGap });
        });
        return;
      }
      (requirementsSnapshot.bubbles || []).filter((bubble) => matches(rule, bubble)).forEach((bubble) => {
        const bubbleMetric = bubbleMetrics.find((item) => item.bubbleId === bubble.id);
        if (rule.kind === "repeatability") {
          if (rule.parameters.requireIdentical && !bubbleMetric.repeatability.identicalShapes) finding(rule, "repeatability_shapes_differ", { bubbleId: bubble.id, actual: bubbleMetric.repeatability.distinctShapeCount, threshold: 1 });
          return;
        }
        bubbleMetric.assignedZoneIds.forEach((zoneId, index) => {
          const metric = zoneById.get(zoneId);
          if (rule.kind === "area-tolerance" && bubbleMetric.relativeAreaDeviations[index] !== null && bubbleMetric.relativeAreaDeviations[index] > rule.parameters.maxRelativeDeviation) finding(rule, "area_deviation_above_max", { bubbleId: bubble.id, zoneId, actual: bubbleMetric.relativeAreaDeviations[index], threshold: rule.parameters.maxRelativeDeviation });
          if (rule.kind === "aspect-ratio" && rule.parameters.minimum !== undefined && metric.aspectRatio < rule.parameters.minimum) finding(rule, "aspect_ratio_below_min", { bubbleId: bubble.id, zoneId, actual: metric.aspectRatio, threshold: rule.parameters.minimum });
          if (rule.kind === "aspect-ratio" && rule.parameters.maximum !== undefined && metric.aspectRatio > rule.parameters.maximum) finding(rule, "aspect_ratio_above_max", { bubbleId: bubble.id, zoneId, actual: metric.aspectRatio, threshold: rule.parameters.maximum });
          if (rule.kind === "compactness" && metric.boundingBoxFillRatio < rule.parameters.minimumFillRatio) finding(rule, "compactness_below_min", { bubbleId: bubble.id, zoneId, actual: metric.boundingBoxFillRatio, threshold: rule.parameters.minimumFillRatio });
        });
      });
    });
    const requiredFindings = criticFindings.filter((item) => item.severity === "required");
    const preferredFindings = criticFindings.filter((item) => item.severity === "preferred");
    return clone({ version: 1, variantId: variant.variantId, requirementsSnapshotId: requirementsSnapshot.requirementsSnapshotId, dataErrors: validation.dataErrors, hardViolations: [...validation.hardViolations, ...requiredFindings], softIssues: [...validation.softIssues, ...preferredFindings], metrics: { validation: validation.metrics, zones: zoneMetrics, bubbles: bubbleMetrics, relationships: validation.metrics.relationships }, qualityDimensions: { areaFit: bubbleMetrics.map(({ bubbleId, targetAreaSqm, actualAreasSqm, relativeAreaDeviations }) => ({ bubbleId, targetAreaSqm, actualAreasSqm, relativeAreaDeviations })), shape: zoneMetrics, relationships: validation.metrics.relationships, repeatability: bubbleMetrics.map(({ bubbleId, repeatability }) => ({ bubbleId, ...repeatability })) }, criticFindings });
  }

  window.LayoutIntelligence = { normalizeRulePack, requireValidRulePack, buildLayoutProblem, evaluateVariant, shapeSignature };
})();
