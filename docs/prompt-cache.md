# Prompt caching (pi-ai + Pi harness)

How the orchestrator spine sets cache hints, how Pi skills interact with the cached prefix, and how each provider layer realizes caching. See also `deterministic-agent-delivery-pipeline-spec.md` (D10 provenance, D18 defaults).

## Spine cache hints (`pi-ai`)

`@earendil-works/pi-ai` exposes prompt-cache controls on `StreamOptions` / `SimpleStreamOptions`:

| Field | Type | Role |
| --- | --- | --- |
| `sessionId` | `string` | Session affinity key for provider prompt caching |
| `cacheRetention` | `"none"` \| `"short"` \| `"long"` | Retention preference; providers map to their API (default in pi-ai: `"short"`) |

The spine sets these via `PromptCacheHint` in `src/pi/prompt-cache.ts`:

- `createCachedStreamFn(hint)` wraps `streamSimple` and merges hints into every LLM call.
- `pi-agent-core` `Agent` also accepts `sessionId`; the spine should set **both** `agent.sessionId` and the stream wrapper so agent-loop `config` and the stream fn stay aligned.

Observability: assistant messages carry `usage.cacheRead` and `usage.cacheWrite` (`pi-ai` `Usage` type). The stub faux provider simulates the same fields when `sessionId` is set and `cacheRetention !== "none"`.

## Pi on-demand skills and the cached prefix

Pi skills use **progressive disclosure** (`pi-coding-agent` `docs/skills.md`):

1. At startup, only skill **names and descriptions** are injected into the system prompt (Agent Skills XML).
2. Full `SKILL.md` bodies load **on demand** via the agent `read` tool when needed.

That split preserves a **stable prefix**: system prompt (including the skill index) plus early turns stay identical across invocations; loading a skill appends new user/tool messages **after** that prefix rather than rewriting it. Pi also keeps date-only (not time) in default system prompts so reload/resume prefixes stay cacheable (`pi-coding-agent` CHANGELOG).

Implication for the spine: issue a stable `sessionId` per lineage/workspace where prefix reuse is expected; skill loads should not mutate the frozen system prompt block.

## How providers realize caching

Mapping is implemented inside `@earendil-works/pi-ai` per API adapter (when `cacheRetention !== "none"` and `sessionId` is present):

| Provider / API | Mechanism (summary) |
| --- | --- |
| **Faux** (`registerFauxProvider`) | In-memory map keyed by `sessionId`; common-prefix of serialized context → `usage.cacheRead` / `cacheWrite` on repeat calls |
| **Anthropic** (`anthropic-messages`) | `cache_control` breakpoints on system prompt, tools, and trailing content; long retention → `ttl: "1h"` when `cacheRetention: "long"` |
| **OpenAI Responses** (`openai-responses`) | `prompt_cache_key` (= `sessionId`), optional `prompt_cache_retention: "24h"` when `long` |
| **OpenAI Completions** (incl. many compat providers) | `prompt_cache_key` on OpenAI hosts; optional `cache_control` markers when `compat.cacheControlFormat: "anthropic"` |
| **OpenAI Codex** (`openai-codex-responses`) | `prompt_cache_key`; optional WebSocket session reuse per `sessionId` |
| **Cloudflare AI Gateway** | `x-session-affinity` header for prefix caching (`pi-coding-agent` `docs/providers.md`) |
| **Amazon Bedrock** | Cache points on Claude models; `AWS_BEDROCK_FORCE_CACHE=1` for opaque ARNs |

Providers that do not implement caching ignore `sessionId` / `cacheRetention`. Configure custom models via `models.json` (`cacheControlFormat`, `supportsLongCacheRetention`) — see `pi-coding-agent` `docs/models.md`.

Environment: Pi CLI honors `PI_CACHE_RETENTION=long` for extended retention where supported.

## Stub `done_when`

`src/spikes/s1-prompt-cache.test.ts` asserts: two stub invocations sharing the same faux registration, `sessionId`, system prompt, and user-message prefix report `usage.cacheRead > 0` on the **second** call (first call writes cache, second reads it).

Production spine code should pass `PromptCacheHint` into agent invocation; tests use the shared faux registration because `registerFauxProvider` keeps its prompt-cache map for the lifetime of the registration.
