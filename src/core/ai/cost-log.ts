/**
 * Per-call Anthropic/OpenAI API cost ledger.
 *
 * Appends ONE JSONL record per LLM call to `~/.gbrain/logs/api-cost.jsonl`
 * (overridable via `$GBRAIN_API_COST_LOG`) — the same path + schema that the
 * `gbrain-api-cost` skill's rollup, the nightly observability snapshot
 * (`api_cost_mtd_usd`), and the daily dashboard already read.
 *
 * Added 2026-08-10: the autopilot's own `chat()` / `embed()` calls were the
 * ONLY metered API spenders that logged nothing, so month-to-date spend was
 * invisible on-disk while credits silently drained. This closes that blind
 * spot at the single gateway chokepoint.
 *
 * Logging MUST NEVER throw — it is invoked from the LLM hot path, so every
 * failure is swallowed. Best-effort by design.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalLookup } from '../model-pricing.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';

const LEDGER = process.env.GBRAIN_API_COST_LOG
  ? process.env.GBRAIN_API_COST_LOG
  : join(homedir(), '.gbrain', 'logs', 'api-cost.jsonl');

let _dirEnsured = false;

/** Best-effort USD cost for one call; null when the model isn't priced. */
function costUsd(
  model: string,
  kind: 'chat' | 'embed',
  inTok: number,
  outTok: number,
): number | null {
  if (kind === 'embed') {
    const p = lookupEmbeddingPrice(model);
    if (p.kind !== 'known') return null;
    return (inTok / 1_000_000) * p.pricePerMTok;
  }
  const p = canonicalLookup(model);
  if (!p) return null;
  return (inTok / 1_000_000) * p.input + (outTok / 1_000_000) * p.output;
}

/**
 * Append one call's usage + derived cost to the ledger. `model` is the
 * provider-prefixed id (e.g. `anthropic:claude-sonnet-4-6`); `cost_usd` is
 * computed here from gbrain's canonical price tables so the rollup can total
 * it directly regardless of model-name spelling.
 */
export function logApiCost(rec: {
  model: string;
  source: string;
  input_tokens: number;
  output_tokens: number;
  kind: 'chat' | 'embed';
}): void {
  try {
    const inTok = Math.max(0, Math.round(rec.input_tokens || 0));
    const outTok = Math.max(0, Math.round(rec.output_tokens || 0));
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: rec.source,
      model: rec.model,
      input_tokens: inTok,
      output_tokens: outTok,
      cache_read_input_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cost_usd: costUsd(rec.model, rec.kind, inTok, outTok),
    });
    if (!_dirEnsured) {
      mkdirSync(dirname(LEDGER), { recursive: true });
      _dirEnsured = true;
    }
    appendFileSync(LEDGER, line + '\n');
  } catch {
    // cost logging must never break the LLM path
  }
}
