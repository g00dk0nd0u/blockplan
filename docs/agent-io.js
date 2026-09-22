"use strict";

(function installBlockPlanAgentIo() {
  const api = window.BlockPlanAPI;
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const CONTRACT = "blockplan.generation-request/v1";
  let latestRequest = null;

  const instructions = [
    "Output BlockPlan candidate geometry matching the candidate schema, not prose-only proposals.",
    "Produce materially distinct strategies, not trivial translations or permutations.",
    "Satisfy Bubble quantity requirements and approximate requested areas on the current module grid.",
    "Satisfy required adjacency and separation before preferred relationships.",
    "Improve preferred adjacency and near relationships where practical.",
    "Keep every Zone contiguous and avoid overlapping cells.",
    "Assign every generated semantic Zone explicitly to its source Bubble."
  ];

  const candidateOutput = {
    submissionTool: "submit_generated_variants",
    schema: {
      requirementsSnapshotId: "string",
      parentVariantId: "string|null (required for iteration submissions)",
      candidates: [{
        strategy: "non-empty string",
        rationale: "non-empty string",
        generator: "optional provider-neutral object",
        blockPlan: {
          moduleSizeMm: "positive number",
          categories: [{ id: "string", name: "string", color: "#RRGGBB" }],
          cells: { "x,y": { categoryId: "string", zoneId: "string" } },
          zoneAssignments: { "zoneId": { bubbleId: "string" } }
        }
      }]
    },
    prohibited: ["recursive Plan objects", "validation results", "Bubble position", "underlay data", "screenshots", "provider credentials"],
    instructions
  };

  function fail(code, error, details) {
    const result = { ok: false, error: String(error), code };
    if (details !== undefined) result.details = clone(details);
    return result;
  }

  function count(value, fallback = 3) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error("requestedVariantCount must be a positive integer");
    return number;
  }

  function rootRequest(requirementsSnapshotId, options = {}) {
    const context = api.getGenerationContext(requirementsSnapshotId, options.memoryContext || {});
    if (context && context.ok === false) throw new Error(context.error);
    return clone({
      contract: CONTRACT,
      requestType: "generation",
      requirementsSnapshotId,
      requestedVariantCount: count(options.requestedVariantCount),
      requirements: context.requirementsSnapshot,
      moduleSizeMm: context.workingBlockPlan.moduleSizeMm,
      categories: context.workingBlockPlan.categories,
      relevantMemory: context.relevantMemory || [],
      candidateOutput
    });
  }

  function prepareGenerationRequest(options = {}) {
    try {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("arguments must be an object");
      const validation = api.validateBubbleDiagram();
      if (!validation.ok) return fail("INVALID_BUBBLE_DIAGRAM", "Bubble Diagram is invalid", validation.errors);
      const diagram = api.getBubbleDiagram();
      if (diagram && diagram.ok === false) throw new Error(diagram.error);
      if (!diagram.bubbles.length) return fail("EMPTY_BUBBLE_DIAGRAM", "Add at least one Bubble before preparing generation");
      count(options.requestedVariantCount);
      const created = api.createRequirementsSnapshot({ metadata: { purpose: "ai-generation" } });
      if (!created.ok) throw new Error(created.error);
      latestRequest = rootRequest(created.requirementsSnapshot.requirementsSnapshotId, options);
      return { ok: true, request: clone(latestRequest) };
    } catch (error) { return fail("PREPARE_FAILED", error.message || error); }
  }

  function getGenerationRequest(options = {}) {
    try {
      const id = typeof options === "string" ? options : options.requirementsSnapshotId;
      if (!id) throw new Error("requirementsSnapshotId is required");
      const request = rootRequest(id, typeof options === "object" ? options : {});
      latestRequest = request;
      return { ok: true, request: clone(request) };
    } catch (error) { return fail("REQUEST_NOT_FOUND", error.message || error); }
  }

  function submitGeneratedVariants(options = {}) {
    try {
      const result = api.createVariants(options);
      if (!result.ok) return fail("INVALID_VARIANT_SUBMISSION", result.error);
      return { ok: true, variants: clone(result.variants), variantIds: result.variants.map((variant) => variant.variantId) };
    } catch (error) { return fail("SUBMISSION_FAILED", error.message || error); }
  }

  function getVariantValidation(options = {}) {
    const variantId = typeof options === "string" ? options : options.variantId;
    if (!variantId) return fail("MISSING_VARIANT_ID", "variantId is required");
    const validation = api.validateVariantAgainstDiagram(variantId);
    if (validation && validation.ok === false) return fail("VALIDATION_FAILED", validation.error);
    return { ok: true, variantId, validation: clone(validation) };
  }

  function activateVariant(options = {}) {
    const variantId = typeof options === "string" ? options : options.variantId;
    if (!variantId) return fail("MISSING_VARIANT_ID", "variantId is required");
    const result = api.activateVariant(variantId);
    return result.ok ? clone(result) : fail("ACTIVATION_FAILED", result.error);
  }

  function getIterationRequest(options = {}) {
    try {
      if (!options || typeof options !== "object" || Array.isArray(options) || !options.variantId) throw new Error("variantId is required");
      const context = api.getIterationContext(options.variantId, options.memoryContext || {});
      if (context && context.ok === false) throw new Error(context.error);
      const request = clone({
        contract: CONTRACT,
        requestType: "iteration",
        requirementsSnapshotId: context.nextChildDefaults.requirementsSnapshotId,
        parentVariantId: context.nextChildDefaults.parentVariantId,
        requestedVariantCount: count(options.requestedVariantCount),
        requirements: context.requirementsSnapshot,
        currentVariant: context.variant,
        currentValidation: context.validation,
        lineage: context.lineage,
        reviews: context.reviews,
        relevantMemory: context.relevantMemory || [],
        moduleSizeMm: context.variant.blockPlan.moduleSizeMm,
        categories: context.variant.blockPlan.categories,
        candidateOutput
      });
      latestRequest = request;
      return { ok: true, request: clone(request) };
    } catch (error) { return fail("ITERATION_REQUEST_FAILED", error.message || error); }
  }

  const tools = [
    ["prepare_generation_request", "Validate the current Bubble Diagram, create one immutable Requirements Snapshot, and return an AI generation request."],
    ["get_generation_request", "Rebuild a request for an existing Requirements Snapshot without mutation."],
    ["submit_generated_variants", "Atomically submit multiple immutable candidates without activation."],
    ["get_variant_validation", "Derive validation for a Variant without persisting it."],
    ["activate_variant", "Activate a Variant through BlockPlanAPI."],
    ["get_iteration_request", "Build an iteration request from existing lineage, validation, Reviews, and approved Memory."]
  ].map(([name, description]) => ({ name, description }));

  const handlers = {
    prepare_generation_request: prepareGenerationRequest,
    get_generation_request: getGenerationRequest,
    submit_generated_variants: submitGeneratedVariants,
    get_variant_validation: getVariantValidation,
    activate_variant: activateVariant,
    get_iteration_request: getIterationRequest
  };

  const resources = [
    { uri: "blockplan://generation/latest-request", name: "Latest prepared generation or iteration request" },
    { uri: "blockplan://bubble-diagram", name: "Current Bubble Diagram" },
    { uri: "blockplan://variants", name: "Immutable generation Variants" }
  ];

  const agent = {
    version: "1.0",
    listTools() { return { ok: true, tools: clone(tools) }; },
    callTool(tool, argumentsValue = {}) {
      if (!handlers[tool]) return fail("UNKNOWN_TOOL", `Unknown tool: ${tool}`);
      return handlers[tool](argumentsValue || {});
    },
    listResources() { return { ok: true, resources: clone(resources) }; },
    readResource(uri) {
      try {
        if (uri === "blockplan://generation/latest-request") return latestRequest ? { ok: true, uri, contents: clone(latestRequest) } : fail("NO_PREPARED_REQUEST", "No generation request has been prepared");
        if (uri === "blockplan://bubble-diagram") return { ok: true, uri, contents: clone(api.getBubbleDiagram()) };
        if (uri === "blockplan://variants") return { ok: true, uri, contents: clone(api.listVariants()) };
        return fail("UNKNOWN_RESOURCE", `Unknown resource: ${uri}`);
      } catch (error) { return fail("RESOURCE_READ_FAILED", error.message || error); }
    },
    execute(input = {}) {
      if (input.tool) return this.callTool(input.tool, input.arguments || {});
      if (input.action === "tools" || input.action === "list_tools") return this.listTools();
      if (input.action === "resources" || input.action === "list_resources") return this.listResources();
      if (input.action === "read_resource") return this.readResource(input.uri);
      return fail("INVALID_REQUEST", "Use { tool, arguments }, list_tools, list_resources, or read_resource");
    }
  };
  window.BlockPlanAgent = agent;

  const generateButton = document.getElementById("generateBlockPlansButton");
  const readyStatus = document.getElementById("generationReadyStatus");
  generateButton.addEventListener("click", () => {
    const result = prepareGenerationRequest();
    readyStatus.textContent = result.ok
      ? `AI request ready · ${result.request.requirementsSnapshotId}`
      : `Request not ready · ${result.error}`;
  });

  const agentMode = new URLSearchParams(window.location.search).get("agent") === "1";
  const panel = document.getElementById("agentIoPanel");
  const discovery = document.getElementById("agentIoDiscovery");
  if (agentMode) {
    panel.hidden = false;
    discovery.textContent = JSON.stringify({ tools: agent.listTools().tools, resources: agent.listResources().resources }, null, 2);
  }

  function dispatchResult(detail) {
    const command = detail && detail.command ? detail.command : detail;
    const result = agent.execute(command || {});
    const response = { id: detail && detail.id ? detail.id : String(Date.now()), ok: Boolean(result && result.ok), result };
    panel.dataset.lastResult = JSON.stringify(response);
    document.dispatchEvent(new CustomEvent("blockplan:agent-result", { detail: response }));
  }
  document.addEventListener("blockplan:agent-request", (event) => dispatchResult(event.detail || {}));
})();
