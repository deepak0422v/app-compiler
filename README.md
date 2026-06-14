# AppCompiler — NL → App Config Pipeline

Natural language → structured config → validated → executable app schema.

# Live Demo:
https://app-compiler-seven.vercel.app
---

# Preview:
<h1 align="center">AI App Compiler</h1>

<p align="center">
  <img src="assets/ai_pp_compiler_ui.jpeg" alt="AI App Compiler UI" width="1000"/>
</p>

# AI App Compiler

AI App Compiler is a multi-stage LLM-powered system that transforms natural language application requirements into validated software blueprints.

Instead of generating output through a single AI prompt, the system follows a compiler-style pipeline that progressively converts user requirements into structured application specifications, including architecture design, database schemas, API definitions, UI components, business rules, and validation reports.

## Features

- Natural language requirement analysis
- Intent extraction and feature identification
- Application architecture generation
- Database schema generation
- REST API specification generation
- UI component definition generation
- Ambiguity detection and assumption handling
- Cross-layer validation (UI → API → Database)
- Automatic JSON repair and consistency checks
- Execution simulation and validation scoring

## Architecture

```
User Prompt
    │
    ▼
[Ambiguity Detection]    → flags vague/conflicting inputs before pipeline starts
    │
    ▼
[Stage 1: Intent Extraction]   → structured intent JSON
    │
    ▼
[Stage 2: System Architecture] → entities, pages, auth, flows
    │
    ▼
[Stage 3: Schema Generation]   → DB + API + UI + business logic
    │
    ▼
[Stage 4: Validation + Repair] → cross-layer checks + targeted auto-fix
    │
    ▼
[Execution Simulator]          → validates output is runtime-ready
    │
    ▼
Final Config JSON (directly usable — no manual fixes)
```

Each stage is a **separate LLM call** with a strict JSON output contract.  
The repair engine detects invalid JSON and schema mismatches and fixes them **surgically** (not full retry).

---

## Determinism Strategy

| Technique | Implementation |
|-----------|---------------|
| Temperature | `0` on every LLM call |
| Schema contracts | Each stage has an exact required JSON schema in its system prompt |
| Staged isolation | Each stage only receives the prior stage's output — no full context bleed |
| Targeted repair | On failure, only the broken layer is re-generated, not the whole pipeline |

Same prompt → consistent output within the variance of the underlying model at `temp=0`.

---

## Deploy to Vercel (5 minutes)

```bash
# 1. Unzip / clone the repo
cd app-compiler

# 2. Install Vercel CLI
npm i -g vercel

# 3. Deploy
vercel --prod
```

Vercel gives you a live URL. No environment variables needed — users supply their own OpenRouter key in the UI.

---

## Local Dev

```bash
npm i -g vercel
vercel dev
# Open http://localhost:3000
```

---

## Usage

1. Open the app URL  
2. Paste your **OpenRouter API key** (`sk-or-v1-…`) in the header  
3. Type a prompt or choose an example  
4. Hit **Compile**

> **Get a free OpenRouter key:** https://openrouter.ai — the default model (`google/gemma-3-12b-it:free`) costs $0.

---

## Output Schema

```json
{
  "intent": {
    "app_name": "string",
    "app_type": "string",
    "core_features": ["string"],
    "user_roles": ["string"],
    "monetization": "string | null",
    "integrations": ["string"],
    "assumptions": ["string — every inference and conflict resolution is documented here"]
  },
  "architecture": {
    "entities": [{ "name": "string", "type": "model|service", "fields": ["string"], "relations": ["string"] }],
    "pages": [{ "name": "string", "route": "string", "roles": ["string"], "components": ["string"] }],
    "auth": {
      "strategy": "string",
      "roles": ["string"],
      "permissions": [{ "role": "string", "can": ["string"] }]
    },
    "flows": [{ "name": "string", "steps": ["string"] }]
  },
  "schemas": {
    "database": {
      "tables": [{ "name": "string", "columns": [{ "name": "string", "type": "string", "nullable": false, "references": "table.column | null" }], "indexes": ["string"] }]
    },
    "api": {
      "base_url": "/api/v1",
      "endpoints": [{ "method": "GET|POST|PUT|DELETE|PATCH", "path": "string", "auth_required": true, "roles": ["string"], "request_body": {}, "response": {} }]
    },
    "ui": {
      "design_system": { "primary_color": "string", "font": "string", "component_library": "string" },
      "components": [{ "name": "string", "props": ["string"], "api_calls": ["string"] }]
    },
    "business_logic": [{ "rule": "string", "trigger": "string", "action": "string" }]
  }
}
```

---

## Validation Checks (12 total)

| # | Check | Type |
|---|-------|------|
| 1 | Intent parsed correctly | hard |
| 2 | DB tables present | hard |
| 3 | API endpoints defined | hard |
| 4 | UI components defined | hard |
| 5 | Entity → DB mapping | soft |
| 6 | Auth guards on endpoints | soft |
| 7 | No duplicate API paths | hard |
| 8 | RBAC defined | soft |
| 9 | Business logic rules | soft |
| 10 | UI → API consistency | soft |
| 12 | Deep field-level consistency
| 13 | Role consistency | soft |

Hard failures trigger the **targeted refinement pass** (Stage 4 re-generates only the broken layer).

---

## Ambiguity & Failure Handling

The pipeline detects and handles:

| Signal | Detection | Resolution |
|--------|-----------|------------|
| Very short prompt | Word count < 6 | Make reasonable assumptions, document in `assumptions` array |
| No auth mentioned | Keyword scan | Assume basic single-user auth |
| Conflicting monetization | "free" + revenue terms | Resolve to freemium, document assumption |
| Role conflicts | Semantic check | Resolve pragmatically, document |
| Real-time + no WebSocket | Keyword contradiction | Suggest SSE, document |
| Missing UI pages | Keyword scan | Infer from features |

Assumptions are **always documented** in `intent.assumptions` — the evaluator can see exactly what the system inferred.

---

## Evaluation Results

See `evaluation/dataset.json` for full results on 20 prompts (10 real + 10 edge cases).

### Summary

| Category | Success Rate | Avg Validation Score | Avg Latency | Avg Repairs |
|----------|-------------|---------------------|-------------|-------------|
| Real prompts (10) | 100% | 85% | 30.3s | 0.6 |
| Edge cases (10) | 100% | 71% | 27.5s | 1.4 |
| **Overall (20)** | **100%** | **78%** | **28.9s** | **1.0** |

Most common failure type: **Business logic rules** (model under-specifies trigger-action pairs on simple prompts) — resolved by the refinement pass when it causes a hard failure.

---

## Cost vs Quality Tradeoff

| Model | Cost/run (est.) | Quality | Latency |
|-------|-----------------|---------|---------|
| `google/gemma-3-12b-it:free` | $0.00 | Good | 25–45s |
| `mistralai/mistral-7b-instruct:free` | $0.00 | Good | 20–35s |
| `meta-llama/llama-3-70b-instruct` | ~$0.004 | Better | 15–25s |
| `anthropic/claude-3-haiku` | ~$0.006 | Better+ | 10–20s |
| `anthropic/claude-3-5-sonnet` | ~$0.018 | Best | 15–30s |

The system is model-agnostic — swap the `MODEL` constant in `api/compile.js` to upgrade quality.

---

## Reliability Features

- ✅ 4-stage modular pipeline (compiler architecture)
- ✅ Ambiguity detection before pipeline starts
- ✅ Targeted JSON repair engine (not brute-force retry)
- ✅ 12-point cross-layer validation
- ✅ Stage 4 targeted refinement (surgical fixes only)
- ✅ Execution simulation (routes, tables, endpoints, permissions)
- ✅ Stateful session tracking (run history, metrics)
- ✅ Temperature = 0 for determinism
- ✅ All assumptions documented in output

## Example Input

Build a CRM with login, contacts, deal pipeline, analytics dashboard, role-based access, and Stripe payment integration.

## Generated Output

- Application Architecture
- Database Schema
- REST API Specifications
- UI Components
- User Roles & Permissions
- Business Rules
- Validation Report

## Tech Stack

- JavaScript
- OpenRouter API
- Vercel
- REST APIs
- JSON Processing
- LLM-Based Structured Generation

## Challenges Solved

- Structured JSON generation from LLMs
- Ambiguous requirement handling
- Multi-stage AI orchestration
- Cross-layer consistency validation
- Automatic repair of malformed outputs
- Serverless deployment optimization
