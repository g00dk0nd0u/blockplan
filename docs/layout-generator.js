"use strict";

(function installLayoutGenerator() {
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const DEFAULTS = Object.freeze({ requestedVariantCount: 3, beamWidth: 32, maxStates: 50000, maxPlacementCandidatesPerInstance: 48, maxRepairIterations: 8, maxShapeCandidatesPerInstance: 8 });

  function normalizeGenerationFrame(source) { return LayoutIntelligence.normalizeGenerationFrame(source); }

  function normalizeOptions(source = {}) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Layout generator options must be an object");
    const allowed = new Set(Object.keys(DEFAULTS));
    Object.keys(source).forEach((key) => { if (!allowed.has(key)) throw new Error(`Unsupported layout generator option: ${key}`); });
    const result = { ...DEFAULTS };
    Object.keys(source).forEach((key) => {
      if (!Number.isInteger(source[key]) || source[key] <= 0) throw new Error(`${key} must be a positive integer`);
      result[key] = source[key];
    });
    return result;
  }

  function expandSpaceInstances(problem) {
    const diagnostics = [], instances = [];
    const cellAreaSqm = Math.pow(problem.moduleSizeMm / 1000, 2);
    (problem.spaces || []).forEach((space) => {
      const assumedSingle = space.quantity === null || space.quantity === undefined;
      const quantity = assumedSingle ? 1 : space.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        diagnostics.push({ code: "invalid_quantity", bubbleId: space.bubbleId });
        return;
      }
      const size = space.targetSize;
      const evaluable = size && typeof size.value === "number" && Number.isFinite(size.value) && size.value > 0 && ["sqm", "m2", "m²"].includes(String(size.unit).toLowerCase());
      if (!evaluable) {
        diagnostics.push({ code: "missing_evaluable_size", bubbleId: space.bubbleId, unit: size && size.unit });
        return;
      }
      for (let index = 1; index <= quantity; index += 1) instances.push({
        instanceId: `${space.bubbleId}::${index}`, bubbleId: space.bubbleId, type: space.type,
        targetAreaSqm: size.value, targetCellCount: Math.max(1, Math.round(size.value / cellAreaSqm)),
        quantityIndex: index, quantityAssumedSingle: assumedSingle
      });
    });
    return { instances, diagnostics, cellAreaSqm };
  }

  function applicableRules(problem, instance, kind) {
    return ((problem.rulePack && problem.rulePack.rules) || []).filter((rule) => rule.kind === kind && (!rule.selector.bubbleIds || rule.selector.bubbleIds.includes(instance.bubbleId)) && (!rule.selector.types || rule.selector.types.includes(instance.type)));
  }

  function enumerateShapeCandidates(instance, problem, options = {}) {
    const limit = options.maxShapeCandidatesPerInstance || DEFAULTS.maxShapeCandidatesPerInstance;
    const target = instance.targetCellCount;
    const maxSide = Math.max(2, Math.ceil(Math.sqrt(target) * 3));
    const seen = new Map();
    for (let width = 1; width <= maxSide; width += 1) for (let height = 1; height <= maxSide; height += 1) {
      const count = width * height;
      if (Math.abs(count - target) > Math.max(2, Math.ceil(target * 0.35))) continue;
      const candidate = { widthCells: width, heightCells: height, cellCount: count, actualAreaSqm: count * Math.pow(problem.moduleSizeMm / 1000, 2), relativeAreaDeviation: Math.abs(count - target) / target, aspectRatio: Math.max(width, height) / Math.min(width, height) };
      const requiredArea = applicableRules(problem, instance, "area-tolerance").filter((rule) => rule.severity === "required");
      const requiredAspect = applicableRules(problem, instance, "aspect-ratio").filter((rule) => rule.severity === "required");
      if (requiredArea.some((rule) => candidate.relativeAreaDeviation > rule.parameters.maxRelativeDeviation)) continue;
      if (requiredAspect.some((rule) => (rule.parameters.minimum !== undefined && candidate.aspectRatio < rule.parameters.minimum) || (rule.parameters.maximum !== undefined && candidate.aspectRatio > rule.parameters.maximum))) continue;
      seen.set(`${width}x${height}`, candidate);
    }
    return [...seen.values()].sort((a, b) => a.relativeAreaDeviation - b.relativeAreaDeviation || a.aspectRatio - b.aspectRatio || a.widthCells - b.widthCells || a.heightCells - b.heightCells).slice(0, limit);
  }

  function relationshipIntentions(problem, instances) {
    const byBubble = new Map();
    instances.forEach((item) => { if (!byBubble.has(item.bubbleId)) byBubble.set(item.bubbleId, []); byBubble.get(item.bubbleId).push(item); });
    const intentions = [];
    (problem.relationships || []).forEach((relationship) => {
      const from = byBubble.get(relationship.fromBubbleId) || [], to = byBubble.get(relationship.toBubbleId) || [];
      const count = Math.max(from.length, to.length);
      for (let index = 0; index < count; index += 1) if (from.length && to.length) intentions.push({
        connectorId: relationship.connectorId, fromInstanceId: from[index % from.length].instanceId,
        toInstanceId: to[index % to.length].instanceId, relationType: relationship.relationType, priority: relationship.priority
      });
    });
    return intentions;
  }

  function buildTopologyStrategies(problem, instances) {
    const intentions = relationshipIntentions(problem, instances);
    const degree = new Map(instances.map((item) => [item.instanceId, 0]));
    intentions.forEach((item) => { const weight = item.priority === "required" ? 2 : 1; degree.set(item.fromInstanceId, degree.get(item.fromInstanceId) + weight); degree.set(item.toInstanceId, degree.get(item.toInstanceId) + weight); });
    const orders = {
      "relationship-first": [...instances].sort((a, b) => degree.get(b.instanceId) - degree.get(a.instanceId) || b.targetCellCount - a.targetCellCount || a.instanceId.localeCompare(b.instanceId)),
      "area-first": [...instances].sort((a, b) => b.targetCellCount - a.targetCellCount || degree.get(b.instanceId) - degree.get(a.instanceId) || a.instanceId.localeCompare(b.instanceId)),
      "repeatability-first": [...instances].sort((a, b) => a.bubbleId.localeCompare(b.bubbleId) || a.quantityIndex - b.quantityIndex || b.targetCellCount - a.targetCellCount)
    };
    return Object.entries(orders).map(([family, order]) => ({ version: 1, strategyId: `${family}-v1`, requirementsSnapshotId: problem.requirementsSnapshotId, family, placementOrder: order.map((item) => item.instanceId), relationshipIntentions: clone(intentions), rationale: { priority: family, deterministic: true, topologyBeforeGeometry: true } }));
  }

  function rectTouches(a, b) {
    const horizontalOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return ((a.x + a.width === b.x || b.x + b.width === a.x) && verticalOverlap > 0)
      || ((a.y + a.height === b.y || b.y + b.height === a.y) && horizontalOverlap > 0);
  }
  function overlaps(a, b) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }
  function inFrame(rect, frame) { const b = frame.bounds; return rect.x >= b.x && rect.y >= b.y && rect.x + rect.width <= b.x + b.width && rect.y + rect.height <= b.y + b.height; }

  function frontierPlacements(shape, state, frame, strategy, instanceId, bubbleId) {
    const results = [], add = (x, y) => results.push({ instanceId, bubbleId, x, y, width: shape.widthCells, height: shape.heightCells, shape });
    const b = frame.bounds;
    if (!state.placements.length) {
      const starts = strategy.family === "area-first" ? [[b.x, b.y], [b.x + b.width - shape.widthCells, b.y + b.height - shape.heightCells]] : strategy.family === "repeatability-first" ? [[b.x, b.y + Math.floor((b.height - shape.heightCells) / 2)], [b.x + b.width - shape.widthCells, b.y]] : [[b.x + Math.floor((b.width - shape.widthCells) / 2), b.y + Math.floor((b.height - shape.heightCells) / 2)], [b.x, b.y]];
      starts.forEach(([x, y]) => add(x, y));
    } else {
      const related = strategy.relationshipIntentions.filter((r) => r.fromInstanceId === instanceId || r.toInstanceId === instanceId).map((r) => r.fromInstanceId === instanceId ? r.toInstanceId : r.fromInstanceId);
      [...state.placements].sort((a, c) => Number(related.includes(c.instanceId)) - Number(related.includes(a.instanceId)) || a.instanceId.localeCompare(c.instanceId)).forEach((p) => {
        add(p.x + p.width, p.y); add(p.x - shape.widthCells, p.y); add(p.x, p.y + p.height); add(p.x, p.y - shape.heightCells);
        add(p.x + p.width, p.y + p.height - shape.heightCells); add(p.x + p.width - shape.widthCells, p.y + p.height);
      });
      add(b.x, b.y); add(b.x + b.width - shape.widthCells, b.y); add(b.x, b.y + b.height - shape.heightCells); add(b.x + b.width - shape.widthCells, b.y + b.height - shape.heightCells);
    }
    const seen = new Set();
    return results.filter((p) => { const key = `${p.x},${p.y},${p.width},${p.height}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }

  function placementFeasible(rect, placements, strategy, frame) {
    if (!inFrame(rect, frame) || placements.some((item) => overlaps(rect, item))) return false;
    const byId = new Map(placements.map((item) => [item.instanceId, item])); byId.set(rect.instanceId, rect);
    return !strategy.relationshipIntentions.some((intent) => intent.priority === "required" && intent.relationType === "separate" && byId.has(intent.fromInstanceId) && byId.has(intent.toInstanceId) && rectTouches(byId.get(intent.fromInstanceId), byId.get(intent.toInstanceId)));
  }

  function stateDimensions(state, strategy) {
    const byId = new Map(state.placements.map((item) => [item.instanceId, item]));
    let requiredMiss = 0, preferredMiss = 0;
    strategy.relationshipIntentions.forEach((intent) => { if (!byId.has(intent.fromInstanceId) || !byId.has(intent.toInstanceId)) return; const touching = rectTouches(byId.get(intent.fromInstanceId), byId.get(intent.toInstanceId)); if (intent.relationType === "adjacent" && !touching) (intent.priority === "required" ? requiredMiss++ : preferredMiss++); });
    const xs = state.placements.flatMap((p) => [p.x, p.x + p.width]), ys = state.placements.flatMap((p) => [p.y, p.y + p.height]);
    const envelope = xs.length ? (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) : 0;
    const areaDeviation = state.placements.reduce((sum, p) => sum + p.shape.relativeAreaDeviation, 0);
    return [requiredMiss, preferredMiss, areaDeviation, envelope];
  }

  function compareStates(a, b, strategy) { const av = stateDimensions(a, strategy), bv = stateDimensions(b, strategy); for (let i = 0; i < av.length; i += 1) if (av[i] !== bv[i]) return av[i] - bv[i]; return JSON.stringify(a.placements).localeCompare(JSON.stringify(b.placements)); }

  function blockPlanFrom(state, problem) {
    const cells = {}, zoneAssignments = {};
    const categories = clone(problem.categories || []);
    if (!categories.some((category) => category.id === "unassigned")) {
      categories.unshift(GenerationModel.categoriesFromBubbles([])[0]);
    }
    const categoryIds = new Set(categories.map((category) => category.id));
    state.placements.forEach((p) => {
      const zoneId = `generated::${p.instanceId}`;
      const bubbleId = p.bubbleId;
      const projectedCategoryId = GenerationModel.bubbleCategoryId(bubbleId);
      const categoryId = categoryIds.has(projectedCategoryId) ? projectedCategoryId : "unassigned";
      zoneAssignments[zoneId] = { bubbleId };
      for (let y = p.y; y < p.y + p.height; y += 1) for (let x = p.x; x < p.x + p.width; x += 1) cells[`${x},${y}`] = { categoryId, zoneId };
    });
    return { moduleSizeMm: problem.moduleSizeMm, categories, cells, zoneAssignments };
  }

  function candidateDimensions(evaluation) {
    const deviations = evaluation.metrics.bubbles.flatMap((b) => b.relativeAreaDeviations).filter((v) => v !== null);
    return { hardViolationCount: evaluation.dataErrors.length + evaluation.hardViolations.length, preferredIssueCount: evaluation.softIssues.length, areaDeviationSum: deviations.reduce((a, b) => a + b, 0), repeatabilityMismatchCount: evaluation.metrics.bubbles.filter((b) => !b.repeatability.identicalShapes).length };
  }
  function dominates(a, b) { const keys = Object.keys(a); return keys.every((key) => a[key] <= b[key]) && keys.some((key) => a[key] < b[key]); }

  function evaluationFor(candidate, problem, requirementsSnapshot) {
    return LayoutIntelligence.evaluateVariant({ variantId: "derived-repair", requirementsSnapshotId: problem.requirementsSnapshotId, blockPlan: candidate.blockPlan }, requirementsSnapshot, { layoutProblem: problem });
  }

  function translatedCandidate(candidate, zoneId, dx, dy, frame) {
    const movedKeys = Object.entries(candidate.blockPlan.cells).filter(([, cell]) => cell.zoneId === zoneId).map(([key]) => key);
    const moving = new Set(movedKeys), replacements = [];
    for (const key of movedKeys) {
      const [x, y] = key.split(",").map(Number), next = `${x + dx},${y + dy}`;
      if (!inFrame({ x: x + dx, y: y + dy, width: 1, height: 1 }, frame) || (candidate.blockPlan.cells[next] && !moving.has(next))) return null;
      replacements.push([next, candidate.blockPlan.cells[key]]);
    }
    const repaired = clone(candidate);
    movedKeys.forEach((key) => delete repaired.blockPlan.cells[key]);
    replacements.forEach(([key, cell]) => { repaired.blockPlan.cells[key] = cell; });
    return repaired;
  }

  function repairCandidate(candidate, { frame, problem, requirementsSnapshot, maxRepairIterations = DEFAULTS.maxRepairIterations } = {}) {
    let current = clone(candidate), evaluation = evaluationFor(current, problem, requirementsSnapshot);
    const moves = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const issueKey = (issue) => JSON.stringify([issue.code, issue.connectorId || null, issue.bubbleId || null, issue.zoneId || null]);
    for (let iteration = 0; iteration < maxRepairIterations; iteration += 1) {
      const currentDimensions = candidateDimensions(evaluation);
      const currentHardIssues = new Set([...evaluation.dataErrors, ...evaluation.hardViolations].map(issueKey));
      let accepted = null;
      for (const zoneId of Object.keys(current.blockPlan.zoneAssignments).sort()) {
        for (const [dx, dy] of moves) {
          const proposal = translatedCandidate(current, zoneId, dx, dy, frame);
          if (!proposal) continue;
          const proposedEvaluation = evaluationFor(proposal, problem, requirementsSnapshot);
          const proposedDimensions = candidateDimensions(proposedEvaluation);
          const proposedHardIssues = [...proposedEvaluation.dataErrors, ...proposedEvaluation.hardViolations];
          const removesHardFailure = proposedDimensions.hardViolationCount < currentDimensions.hardViolationCount && proposedHardIssues.every((issue) => currentHardIssues.has(issueKey(issue)));
          const feasibleParetoImprovement = currentDimensions.hardViolationCount === 0 && proposedDimensions.hardViolationCount === 0 && dominates(proposedDimensions, currentDimensions);
          if (removesHardFailure || feasibleParetoImprovement) { accepted = { candidate: proposal, evaluation: proposedEvaluation }; break; }
        }
        if (accepted) break;
      }
      if (!accepted) break;
      current = accepted.candidate; evaluation = accepted.evaluation;
    }
    return { candidate: current, evaluation };
  }

  function diversitySignature(candidate) {
    const zones = new Map(); Object.entries(candidate.blockPlan.cells).forEach(([key, cell]) => { if (!zones.has(cell.zoneId)) zones.set(cell.zoneId, []); zones.get(cell.zoneId).push(key.split(",").map(Number)); });
    const records = [...zones.entries()].map(([zoneId, points]) => { const assignment = candidate.blockPlan.zoneAssignments[zoneId]; const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]); return { bubbleId: assignment.bubbleId, minX: Math.min(...xs), minY: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 }; });
    const originX = Math.min(...records.map((r) => r.minX)), originY = Math.min(...records.map((r) => r.minY));
    const geometry = records.map((r) => ({ ...r, minX: r.minX - originX, minY: r.minY - originY })).sort((a, b) => a.bubbleId.localeCompare(b.bubbleId) || a.minX - b.minX || a.minY - b.minY);
    const adjacency = [];
    for (let i = 0; i < records.length; i += 1) for (let j = i + 1; j < records.length; j += 1) if (rectTouches({ x: records[i].minX, y: records[i].minY, width: records[i].width, height: records[i].height }, { x: records[j].minX, y: records[j].minY, width: records[j].width, height: records[j].height })) adjacency.push([records[i].bubbleId, records[j].bubbleId].sort().join("~"));
    return JSON.stringify({ geometry, adjacency: adjacency.sort() });
  }

  function meaningfulTopologySignature(candidate) {
    const zones = new Map();
    Object.entries(candidate.blockPlan.cells).forEach(([key, cell]) => {
      if (!zones.has(cell.zoneId)) zones.set(cell.zoneId, []);
      zones.get(cell.zoneId).push(key.split(",").map(Number));
    });
    const records = [...zones.entries()].map(([zoneId, points]) => {
      const assignment = candidate.blockPlan.zoneAssignments[zoneId];
      const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      return { bubbleId: assignment.bubbleId, minX, minY, width: Math.max(...xs) - minX + 1, height: Math.max(...ys) - minY + 1 };
    });
    const bubbles = {};
    records.forEach((record) => {
      if (!bubbles[record.bubbleId]) bubbles[record.bubbleId] = [];
      bubbles[record.bubbleId].push(`${record.width}x${record.height}`);
    });
    const shapes = Object.keys(bubbles).sort().map((bubbleId) => [bubbleId, bubbles[bubbleId].sort()]);
    const spatial = [];
    const relation = (a, b) => {
      const ax = a.minX + a.width / 2, ay = a.minY + a.height / 2;
      const bx = b.minX + b.width / 2, by = b.minY + b.height / 2;
      const xGap = Math.max(0, a.minX - (b.minX + b.width), b.minX - (a.minX + a.width));
      const yGap = Math.max(0, a.minY - (b.minY + b.height), b.minY - (a.minY + a.height));
      if (xGap === 0 && yGap > 0) return ay < by ? "above" : "below";
      if (yGap === 0 && xGap > 0) return ax < bx ? "left" : "right";
      if (xGap === 0 && yGap === 0) return Math.abs(ax - bx) >= Math.abs(ay - by) ? (ax < bx ? "left" : "right") : (ay < by ? "above" : "below");
      return `${ay < by ? "above" : "below"}-${ax < bx ? "left" : "right"}`;
    };
    for (let i = 0; i < records.length; i += 1) for (let j = i + 1; j < records.length; j += 1) {
      let a = records[i], b = records[j];
      if (a.bubbleId > b.bubbleId) [a, b] = [b, a];
      const direction = a.bubbleId === b.bubbleId
        ? relation(a, b).replace(/left|right/, "horizontal").replace(/above|below/, "vertical")
        : relation(a, b);
      spatial.push(`${a.bubbleId}~${b.bubbleId}:${direction}`);
    }
    return JSON.stringify({ shapes, spatial: spatial.sort() });
  }

  function compareCandidateQuality(a, b) {
    for (const key of ["hardViolationCount", "preferredIssueCount", "areaDeviationSum", "repeatabilityMismatchCount"]) {
      if (a.dimensions[key] !== b.dimensions[key]) return a.dimensions[key] - b.dimensions[key];
    }
    return diversitySignature(a).localeCompare(diversitySignature(b)) || a.strategy.localeCompare(b.strategy);
  }

  function selectDiverseCandidates(candidates, count) {
    const pareto = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) => otherIndex !== index && dominates(other.dimensions, candidate.dimensions)));
    const representatives = new Map();
    pareto.forEach((candidate) => {
      const signature = meaningfulTopologySignature(candidate), current = representatives.get(signature);
      if (!current || compareCandidateQuality(candidate, current) < 0) representatives.set(signature, candidate);
    });
    const ordered = [...representatives.values()].sort((a, b) => a.strategy.localeCompare(b.strategy) || meaningfulTopologySignature(a).localeCompare(meaningfulTopologySignature(b)) || diversitySignature(a).localeCompare(diversitySignature(b)));
    const selected = [], signatures = new Set(), families = [...new Set(ordered.map((candidate) => candidate.strategy))];
    for (let familyIndex = 0; selected.length < count; familyIndex += 1) {
      let added = false;
      for (const family of families) {
        const candidate = ordered.filter((item) => item.strategy === family).find((item) => !signatures.has(meaningfulTopologySignature(item)));
        if (!candidate) continue;
        signatures.add(meaningfulTopologySignature(candidate)); selected.push(candidate); added = true;
        if (selected.length === count) break;
      }
      if (!added || familyIndex >= ordered.length) break;
    }
    return selected;
  }

  function inferFrame(instances) { const total = instances.reduce((sum, item) => sum + item.targetCellCount, 0); const side = Math.max(4, Math.ceil(Math.sqrt(total) * 2)); return { version: 1, bounds: { x: 0, y: 0, width: side, height: Math.max(4, Math.ceil(total * 3 / side)) } }; }

  function generateCandidates(problem, requirementsSnapshot, sourceOptions = {}) {
    const options = normalizeOptions(sourceOptions), diagnostics = [];
    const expanded = expandSpaceInstances(problem); diagnostics.push(...expanded.diagnostics);
    if (expanded.diagnostics.length) return { candidates: [], diagnostics, metadata: { frameSource: problem.generationFrame ? "explicit" : "inferred" } };
    const frame = problem.generationFrame ? normalizeGenerationFrame(problem.generationFrame) : inferFrame(expanded.instances);
    const frameSource = problem.generationFrame ? "explicit" : "inferred";
    const instancesById = new Map(expanded.instances.map((instance) => [instance.instanceId, instance]));
    const shapes = new Map(expanded.instances.map((instance) => [instance.instanceId, enumerateShapeCandidates(instance, problem, options)]));
    for (const instance of expanded.instances) if (!shapes.get(instance.instanceId).length) diagnostics.push({ code: "no_feasible_shape", instanceId: instance.instanceId });
    if (diagnostics.length) return { candidates: [], diagnostics, metadata: { frame, frameSource } };
    const strategies = buildTopologyStrategies(problem, expanded.instances), completed = []; let exploredStates = 0, exhausted = false;
    const baseBudget = Math.floor(options.maxStates / strategies.length), remainder = options.maxStates % strategies.length;
    const strategyBudgets = strategies.map((strategy, index) => ({ strategy, allocatedStates: baseBudget + (index < remainder ? 1 : 0) }));
    const strategySearch = [];
    for (const { strategy, allocatedStates } of strategyBudgets) {
      let beam = [{ placements: [] }], strategyExplored = 0, strategyExhausted = false;
      for (const instanceId of strategy.placementOrder) {
        const instance = instancesById.get(instanceId);
        const next = [];
        for (const state of beam) for (const shape of shapes.get(instanceId)) for (const placement of frontierPlacements(shape, state, frame, strategy, instanceId, instance.bubbleId).slice(0, options.maxPlacementCandidatesPerInstance)) {
          if (strategyExplored >= allocatedStates) { strategyExhausted = true; break; }
          strategyExplored += 1; exploredStates += 1;
          if (placementFeasible(placement, state.placements, strategy, frame)) next.push({ placements: [...state.placements, placement] });
        }
        beam = next.sort((a, b) => compareStates(a, b, strategy)).slice(0, options.beamWidth);
        if (strategyExhausted) break;
        if (!beam.length) break;
      }
      let completedCandidateCount = 0;
      beam.slice(0, Math.max(options.requestedVariantCount * 3, 6)).forEach((state, index) => {
        if (state.placements.length !== expanded.instances.length) return;
        const candidate = { strategy: strategy.family, rationale: JSON.stringify({ strategyId: strategy.strategyId, family: strategy.family, candidateIndex: index }), generator: { name: "BlockPlan LayoutGenerator", version: 1, strategyId: strategy.strategyId }, blockPlan: blockPlanFrom(state, problem) };
        const repaired = repairCandidate(candidate, { frame, problem, requirementsSnapshot, maxRepairIterations: options.maxRepairIterations });
        if (!repaired.evaluation.dataErrors.length && !repaired.evaluation.hardViolations.length) { completed.push({ ...repaired.candidate, dimensions: candidateDimensions(repaired.evaluation) }); completedCandidateCount += 1; }
      });
      strategySearch.push({ strategyId: strategy.strategyId, allocatedStates, exploredStates: strategyExplored, exhausted: strategyExhausted, completedCandidateCount });
      if (strategyExhausted) exhausted = true;
    }
    if (exhausted) diagnostics.push({ code: "search_budget_exhausted", maxStates: options.maxStates, exploredStates });
    const selected = selectDiverseCandidates(completed, options.requestedVariantCount).map(({ dimensions, ...candidate }) => candidate);
    if (selected.length < options.requestedVariantCount) diagnostics.push({ code: "fewer_distinct_candidates", requested: options.requestedVariantCount, available: selected.length });
    return clone({ candidates: selected, diagnostics, metadata: { frame, frameSource, exploredStates, strategySearch, strategies: strategies.map(({ version, strategyId, requirementsSnapshotId, family, placementOrder, relationshipIntentions, rationale }) => ({ version, strategyId, requirementsSnapshotId, family, placementOrder, relationshipIntentions, rationale })) } });
  }

  window.LayoutGenerator = { DEFAULTS, normalizeGenerationFrame, normalizeOptions, expandSpaceInstances, enumerateShapeCandidates, buildTopologyStrategies, generateCandidates, repairCandidate, selectDiverseCandidates, diversitySignature, meaningfulTopologySignature, rectTouches };
})();
