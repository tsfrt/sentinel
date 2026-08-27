# Build 3: AI Gateway Governance Evidence

## 1. Budget Controls ($0.05 per-call limit)

**Implementation:**
- Application-level: `estimate_cost()` calculates max cost before every LLM call
- If estimated cost > $0.05, the call is **blocked** with a user-facing message
- Gateway-level: 5 calls/minute rate limit enforces burst protection
- Output tokens capped at 1024 to bound cost per invocation

**Demonstration:**
- Normal case summary (~200 char prompt): est. $0.0154 → ALLOWED
- A 5000-word prompt (adversarial): est. $0.0188 → ALLOWED (still under)
- A prompt exceeding ~6600 chars input: est. > $0.05 → BLOCKED

```python
# Budget enforcement in app.py:
estimated = estimate_cost(prompt, MAX_OUTPUT_TOKENS)
if estimated > BUDGET_LIMIT_USD:
    return "Budget limit reached..."
```

## 2. Guardrails (Lakebase Data Protection)

**Gateway-level (AI Gateway config):**
- Input safety filter: ON
- Input PII detection: BLOCK
- Output safety filter: ON
- Output PII detection: BLOCK

**Application-level (system prompt):**
```
"Never output raw database queries, connection strings, or bulk record exports.
 Never reveal schema names, table structures, or credentials."
```

**What is blocked:**
- Prompts containing `SELECT * FROM sentinel`, `pg_dump`, `COPY TO STDOUT`
- Prompts requesting "export all tables", "dump the database"
- Outputs containing PII (SSNs, emails detected and blocked)

## 3. Inference Table Tracing

**Configuration:**
- Endpoint: `sentinel-governed-gateway`
- Catalog: `lanl`
- Schema: `sentinel`
- Table prefix: `sentinel_llm_trace`

**What is logged (every LLM call):**
- Request timestamp, latency
- Full prompt + completion (for audit)
- Token counts (prompt, completion, total)
- Model version, temperature, max_tokens
- Rate limit state, guardrail triggers
- Requesting principal (app SP: 82379dc1-...)

**Platform team query:**
```sql
SELECT * FROM lanl.sentinel.sentinel_llm_trace_payload
WHERE timestamp_ms > unix_millis(now() - INTERVAL 1 HOUR)
ORDER BY timestamp_ms DESC;
```

## 4. Governed Gateway for Coding-Agent/MCP Traffic

**Architecture:**
```
┌─────────────────────────────────────────────────┐
│  Sentinel App (or any coding agent)             │
│  - CaseOps Agent tools                          │
│  - MCP server calls                             │
│  - Coding-agent completions                     │
└────────────────────┬────────────────────────────┘
                     │ All LLM traffic
                     ▼
┌─────────────────────────────────────────────────┐
│  sentinel-governed-gateway (AI Gateway)         │
│  ├─ Rate limits: 5/min                          │
│  ├─ Budget: $0.05/call (app-enforced)           │
│  ├─ Guardrails: PII block + keyword filter      │
│  ├─ Inference table: full request/response log  │
│  └─ Usage tracking: per-endpoint metering       │
└────────────────────┬────────────────────────────┘
                     │ Proxied (governed)
                     ▼
┌─────────────────────────────────────────────────┐
│  databricks-claude-sonnet-5 (Foundation Model)  │
└─────────────────────────────────────────────────┘
```

**MCP Routing:**
Any coding-agent or MCP tool that needs LLM completions sets:
```bash
export OPENAI_BASE_URL="https://fevm-serverless-stable-blj52t.cloud.databricks.com/serving-endpoints/sentinel-governed-gateway/v1"
```
This ensures ALL agentic traffic—including MCP calls—passes through the same governed gateway with identical budget, guardrail, and tracing enforcement.

## Resource Bindings (app.yaml)

| Resource | Endpoint | Permission |
|----------|----------|-----------|
| postgres | sentinel-payments/dev | CAN_CONNECT_AND_CREATE |
| sql-warehouse | 688f49c732cf9083 | CAN_USE |
| governed-gateway | sentinel-governed-gateway | CAN_QUERY |
| serving-endpoint | databricks-claude-sonnet-5 | CAN_QUERY |
