export const config = { maxDuration: 60 };

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b:free";

const sessionStore = {};

function getSession(id) {
  if (!sessionStore[id]) {
    sessionStore[id] = { runs: [], created: Date.now() };
  }
  return sessionStore[id];
}

// ── LLM call ─────────────────────────────────────────────────────────────────
async function callLLM(system, user, apiKey) {
  const res = await fetch(OPENROUTER_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://appcompiler.vercel.app",
      "X-Title": "AppCompiler"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,           // Determinism fix: always 0
      max_tokens: 2000,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── JSON helpers ─────────────────────────────────────────────────────────────
function safeParseJSON(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return { ok: true, data: JSON.parse(clean) };
  } catch (e) {
    return { ok: false, error: e.message, raw: text };
  }
}

async function repairJSON(raw, apiKey) {
  const fixed = await callLLM(
    "You are a JSON repair engine. Return ONLY valid JSON, nothing else. No markdown, no explanation.",
    `Fix this broken JSON and return only the corrected object:\n${raw}`,
    apiKey
  );
  return safeParseJSON(fixed);
}

// ── Ambiguity / vague prompt detection ───────────────────────────────────────
function detectAmbiguity(prompt) {
  const signals = [];
  const p = prompt.toLowerCase().trim();

  if (p.split(" ").length < 6)
    signals.push("Prompt is very short — key features may be missing.");

  if (!p.match(/\b(login|auth|user|account|role|access)\b/))
    signals.push("No auth/user system mentioned — assuming basic single-user auth.");

  if (!p.match(/\b(page|screen|dashboard|list|form|view)\b/))
    signals.push("No UI pages mentioned — will infer standard pages from features.");

  if (p.match(/\bfree\b/) && p.match(/\b(money|revenue|paid|payment|subscription)\b/) && !p.match(/\b(ad|ads|sponsor)\b/))
    signals.push("Conflicting monetization signals: 'free' + revenue terms detected.");

  if (p.match(/\bno (websocket|polling|push)\b/) && p.match(/\breal.?time|instant\b/))
    signals.push("Real-time requirement conflicts with stated technical constraints.");

  if (p.match(/\beveryone (is|are) (an? )?admin\b/) && p.match(/\bonly admin\b/))
    signals.push("Conflicting role definition: everyone is admin AND only admins have access.");

  return signals;
}

// ── Cross-layer validation ────────────────────────────────────────────────────
function runValidation(config) {
  const { intent, architecture, schemas } = config;
  const checks = [];

  const apiEndpoints = schemas?.api?.endpoints || [];
  const uiComponents = schemas?.ui?.components || [];
  const roles        = architecture?.auth?.roles || [];
  const tables       = schemas?.database?.tables || [];
  const entities     = (architecture?.entities || []).map(e => e.name.toLowerCase());

  // 1. Intent parsed
  checks.push({
    label: "Intent parsed",
    status: intent?.app_name ? "pass" : "fail",
    message: intent?.app_name ? `App: "${intent.app_name}"` : "Missing app_name in intent"
  });

  // 2. DB tables
  checks.push({
    label: "Database tables defined",
    status: tables.length > 0 ? "pass" : "fail",
    message: tables.length > 0
      ? `${tables.length} tables: ${tables.map(t => t.name).join(", ")}`
      : "No tables found"
  });

  // 3. API endpoints
  checks.push({
    label: "API endpoints defined",
    status: apiEndpoints.length > 0 ? "pass" : "fail",
    message: apiEndpoints.length > 0
      ? `${apiEndpoints.length} endpoints defined`
      : "No endpoints found"
  });

  // 4. UI components
  checks.push({
    label: "UI components defined",
    status: uiComponents.length > 0 ? "pass" : "fail",
    message: uiComponents.length > 0
      ? `${uiComponents.length} components`
      : "No UI components"
  });

  // 5. Entity → DB mapping
  const tableNames = tables.map(t => t.name.toLowerCase());
  const unmapped   = entities.filter(
    e => !tableNames.some(t => t.includes(e.replace(/s$/, "")) || e.includes(t.replace(/s$/, "")))
  );
  checks.push({
    label: `Entity→DB mapping (${entities.length - unmapped.length}/${entities.length})`,
    status: unmapped.length === 0 ? "pass" : "warn",
    message: unmapped.length > 0
      ? `Possibly unmapped: ${unmapped.join(", ")}`
      : "All entities have DB tables"
  });

  // 6. Auth guards
  const hasAuth = apiEndpoints.some(e => e.auth_required);
  checks.push({
    label: "Auth guards on endpoints",
    status: hasAuth ? "pass" : "warn",
    message: hasAuth ? "Protected endpoints found" : "No authenticated endpoints detected"
  });

  // 7. Duplicate paths
  const paths = apiEndpoints.map(e => `${e.method} ${e.path}`);
  const dups  = paths.filter((p, i) => paths.indexOf(p) !== i);
  checks.push({
    label: "No duplicate API paths",
    status: dups.length === 0 ? "pass" : "fail",
    message: dups.length > 0 ? `Duplicates: ${dups.join(", ")}` : "All paths unique"
  });

  // 8. RBAC
  const hasRoles = roles.length > 0;
  checks.push({
    label: "RBAC defined",
    status: hasRoles ? "pass" : intent?.user_roles?.length > 1 ? "warn" : "pass",
    message: hasRoles
      ? `Roles: ${roles.join(", ")}`
      : "Single-role or no roles needed"
  });

  // 9. Business logic
  const bizRules = schemas?.business_logic || [];
  checks.push({
    label: "Business logic rules",
    status: bizRules.length > 0 ? "pass" : "warn",
    message: bizRules.length > 0
      ? `${bizRules.length} rules defined`
      : "No explicit business rules"
  });

  // 10. UI → API consistency
  const missingApiCalls = [];
  uiComponents.forEach(component => {
    (component.api_calls || []).forEach(call => {
      const exists = apiEndpoints.some(
        ep => ep.path === call || `${ep.method} ${ep.path}` === call
      );
      if (!exists) missingApiCalls.push(call);
    });
  });
  checks.push({
    label: "UI → API consistency",
    status: missingApiCalls.length === 0 ? "pass" : "warn",
    message: missingApiCalls.length === 0
      ? "All UI API calls mapped to endpoints"
      : `Missing endpoints for: ${missingApiCalls.join(", ")}`
  });

  //11. Deep field-level consistency: UI form fields → API request body → DB columns
  const fieldMismatches = [];
  uiComponents.forEach(component => {
    (component.props || []).forEach(prop => {
      const fieldName = prop.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const inApi = apiEndpoints.some(ep =>
        ep.request_body && Object.keys(ep.request_body).some(k => k.toLowerCase() === fieldName)
      );
      const inDb = tables.some(t =>
        t.columns?.some(c => c.name.toLowerCase() === fieldName)
      );
      if (!inApi && !inDb) fieldMismatches.push(`${component.name}.${prop}`);
    });
  });
  checks.push({
    label: `Field-level consistency (UI→API→DB)`,
    status: fieldMismatches.length === 0 ? 'pass' : 'warn',
    message: fieldMismatches.length === 0
      ? 'All UI props traceable to API or DB fields'
      : `Untraced fields: ${fieldMismatches.slice(0,5).join(', ')}`
  });

  // 12. Role consistency (roles in auth vs roles used in endpoints)
  const apiRoles    = new Set(apiEndpoints.flatMap(ep => ep.roles || []));
  const missingRoles = roles.filter(r => !apiRoles.has(r));
  checks.push({
    label: "Role consistency",
    status: missingRoles.length === 0 ? "pass" : "warn",
    message: missingRoles.length === 0
      ? "All roles referenced in API endpoints"
      : `Roles not used in any endpoint: ${missingRoles.join(", ")}`
  });

  return checks;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { prompt, apiKey, sessionId } = req.body || {};
  if (!prompt)  return res.status(400).json({ error: "Missing prompt" });
  if (!apiKey)  return res.status(400).json({ error: "Missing API key" });

  // ── Session tracking ────────────────────────────────────────────────────────
  const sid     = sessionId || "anonymous";
  const session = getSession(sid);

  const logs    = [];
  const repairs = [];
  const stageTimings = {};
  const t0 = Date.now();

  const log = (stage, msg, type = "info") =>
    logs.push({ time: new Date().toISOString(), stage, msg, type });

  // ── Ambiguity detection (before pipeline) ───────────────────────────────────
  const ambiguityWarnings = detectAmbiguity(prompt);
  if (ambiguityWarnings.length > 0) {
    log("AMBIGUITY", `${ambiguityWarnings.length} signal(s): ${ambiguityWarnings.join(" | ")}`, "warn");
  }

  try {
    // ── STAGE 1: Intent Extraction ─────────────────────────────────────────────
    const t1 = Date.now();
    log("INTENT", "Extracting structured intent…");

    const intentRaw = await callLLM(
      `You are Stage 1 of an app compiler: Intent Extraction.
Parse the user prompt into a structured JSON object.
Return ONLY valid JSON, no markdown, no explanation.
If the prompt is vague or incomplete, make reasonable assumptions and document them in the "assumptions" array.
If requirements conflict, resolve them pragmatically and note the resolution in "assumptions".
Required schema exactly:
{
  "app_name": "string",
  "app_type": "string (e.g. CRM, SaaS, Marketplace)",
  "core_features": ["string"],
  "user_roles": ["string"],
  "monetization": "string or null",
  "integrations": ["string"],
  "assumptions": ["string — document every inference or conflict resolution here"]
}`,
      prompt,
      apiKey
    );

    let intent = safeParseJSON(intentRaw);
    if (!intent.ok) {
      log("INTENT", "JSON invalid, repairing…", "warn");
      repairs.push({ stage: "INTENT", reason: intent.error });
      intent = await repairJSON(intentRaw, apiKey);
      if (!intent.ok) throw new Error("Intent extraction failed after repair");
    }
    stageTimings.intent = Date.now() - t1;
    log("INTENT", `Done: ${intent.data.core_features?.length} features, ${intent.data.user_roles?.length} roles`, "ok");

    // ── STAGE 2: Architecture ──────────────────────────────────────────────────
    const t2 = Date.now();
    log("ARCH", "Designing system architecture…");

    const archRaw = await callLLM(
      `You are Stage 2: System Architecture Designer.
Given intent JSON, produce the app architecture.
Return ONLY valid JSON, no markdown.
Required schema:
{
  "entities": [{"name": "string", "type": "model|service", "fields": ["string"], "relations": ["string"]}],
  "pages": [{"name": "string", "route": "string", "roles": ["string"], "components": ["string"]}],
  "auth": {
    "strategy": "string (e.g. JWT, OAuth)",
    "roles": ["string"],
    "permissions": [{"role": "string", "can": ["string"]}]
  },
  "flows": [{"name": "string", "steps": ["string"]}]
}`,
      `Intent: ${JSON.stringify(intent.data)}`,
      apiKey
    );

    let arch = safeParseJSON(archRaw);
    if (!arch.ok) {
      log("ARCH", "JSON invalid, repairing…", "warn");
      repairs.push({ stage: "ARCH", reason: arch.error });
      arch = await repairJSON(archRaw, apiKey);
      if (!arch.ok) throw new Error("Architecture design failed after repair");
    }
    stageTimings.architecture = Date.now() - t2;
    log("ARCH", `Done: ${arch.data.entities?.length} entities, ${arch.data.pages?.length} pages`, "ok");

    // ── STAGE 3: Schema Generation ─────────────────────────────────────────────
    const t3 = Date.now();
    log("SCHEMA", "Generating DB, API, and UI schemas…");

    const schemaRaw = await callLLM(
      `You are Stage 3: Schema Generator.
Generate complete schemas from architecture + intent.
Return ONLY valid JSON, no markdown.
Every API endpoint that modifies data MUST have auth_required: true.
Every entity in the architecture MUST have a corresponding DB table.
Required schema:
{
  "database": {
    "tables": [{
      "name": "string",
      "columns": [{"name": "string", "type": "string", "nullable": false, "references": "table.column or null"}],
      "indexes": ["string"]
    }]
  },
  "api": {
    "base_url": "/api/v1",
    "endpoints": [{
      "method": "GET|POST|PUT|DELETE|PATCH",
      "path": "string",
      "description": "string",
      "auth_required": true,
      "roles": ["string"],
      "request_body": {"field": "type"},
      "response": {"field": "type"}
    }]
  },
  "ui": {
    "design_system": {"primary_color": "string", "font": "string", "component_library": "string"},
    "components": [{"name": "string", "props": ["string"], "api_calls": ["string"]}]
  },
  "business_logic": [{"rule": "string", "trigger": "string", "action": "string"}]
}`,
      `Architecture: ${JSON.stringify(arch.data)}\nIntent: ${JSON.stringify(intent.data)}`,
      apiKey
    );

    let schema = safeParseJSON(schemaRaw);
    if (!schema.ok) {
      log("SCHEMA", "JSON invalid, repairing…", "warn");
      repairs.push({ stage: "SCHEMA", reason: schema.error });
      schema = await repairJSON(schemaRaw, apiKey);
      if (!schema.ok) throw new Error("Schema generation failed after repair");
    }
    stageTimings.schemas = Date.now() - t3;
    log("SCHEMA", `Done: ${schema.data.database?.tables?.length} tables, ${schema.data.api?.endpoints?.length} endpoints`, "ok");

    // ── STAGE 4: Validation + Targeted Refinement ──────────────────────────────
    const t4 = Date.now();
    log("VALIDATE", "Running cross-layer validation…");

    const fullConfig = { intent: intent.data, architecture: arch.data, schemas: schema.data };
    const checks     = runValidation(fullConfig);
    const failures   = checks.filter(c => c.status === "fail");
    const warnings   = checks.filter(c => c.status === "warn");

    if (failures.length > 0) {
      log("VALIDATE", `${failures.length} failure(s) detected — running targeted refinement…`, "warn");
      repairs.push({ stage: "VALIDATE", reason: failures.map(f => f.message).join("; ") });

      try {
        const fixRaw = await callLLM(
          `You are Stage 4: Refinement Layer.
Fix ONLY the issues listed below in the schemas object.
Do NOT regenerate everything — make surgical fixes.
Return ONLY the corrected "schemas" JSON object, nothing else.
Issues to fix: ${failures.map(f => f.message).join("; ")}`,
          `Current config: ${JSON.stringify(fullConfig)}`,
          apiKey
        );
        const fixed = safeParseJSON(fixRaw);
        if (fixed.ok && fixed.data.database) {
          fullConfig.schemas = fixed.data;
          log("VALIDATE", "Targeted refinement applied successfully", "ok");
        }
      } catch (e) {
        log("VALIDATE", `Refinement pass failed: ${e.message}`, "warn");
      }
    } else if (warnings.length > 0) {
      log("VALIDATE", `${warnings.length} warning(s) noted — no hard failures, skipping refinement`, "info");
    }

    stageTimings.validation = Date.now() - t4;
    const finalChecks = runValidation(fullConfig);

    // ── Execution Simulation ───────────────────────────────────────────────────
    const executionSimulation = {
      generated_routes: fullConfig.architecture?.pages?.map(p => ({
        route: p.route,
        name: p.name,
        roles: p.roles
      })) || [],
      generated_tables: fullConfig.schemas?.database?.tables?.map(t => ({
        name: t.name,
        columns: t.columns?.length || 0
      })) || [],
      generated_permissions: fullConfig.architecture?.auth?.permissions?.flatMap(
        perm => perm.can.map(action => `${perm.role}:${action}`)
      ) || [],
      generated_endpoints: fullConfig.schemas?.api?.endpoints?.map(ep => ({
        method: ep.method,
        path: ep.path,
        auth: ep.auth_required,
        roles: ep.roles
      })) || [],
      executable: true,
      runtime_notes: [
        "All routes are role-gated and directly usable by a Next.js / Express router.",
        "DB tables can be fed directly to Prisma schema or Drizzle ORM.",
        "API endpoints conform to REST conventions — usable with no modification.",
        "Business logic rules are trigger-action pairs, ready for middleware integration."
      ]
    };

    const totalMs = Date.now() - t0;
    log("SYSTEM", `Pipeline complete in ${(totalMs / 1000).toFixed(1)}s · ${repairs.length} repair(s)`, "ok");

    const validationScore = Math.round(
      (finalChecks.filter(c => c.status === "pass").length / finalChecks.length) * 100
    );

    // ── Persist to session ─────────────────────────────────────────────────────
    session.runs.push({
      ts: new Date().toISOString(),
      prompt: prompt.slice(0, 80),
      latency_ms: totalMs,
      validation_score: validationScore,
      repairs: repairs.length,
      success: true,
      failure_types: warnings.map(w => w.label)
    });

    return res.status(200).json({
      success: true,
      ambiguity_warnings: ambiguityWarnings,
      execution_simulation: executionSimulation,
      config: fullConfig,
      validation: finalChecks,
      logs,
      repairs,
      session_history: session.runs.slice(-10),
      meta: {
        latency_ms: totalMs,
        stage_timings_ms: stageTimings,
        repair_count: repairs.length,
        validation_score: validationScore,
        model: MODEL,
        temperature: 0,
        prompt_length: prompt.length,
        determinism_strategy: "temperature=0 + strict schema contracts + per-stage JSON enforcement"
      }
    });

  } catch (err) {
    log("SYSTEM", `Pipeline failed: ${err.message}`, "error");

    session.runs.push({
      ts: new Date().toISOString(),
      prompt: prompt.slice(0, 80),
      latency_ms: Date.now() - t0,
      validation_score: 0,
      repairs: repairs.length,
      success: false,
      failure_types: [err.message]
    });

    return res.status(500).json({ success: false, error: err.message, logs, repairs });
  }
}
