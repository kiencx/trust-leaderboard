// Market-wide ANTB trading activity and round-trip cost, read from the main ANTB/USDT pool on BSC.
//
// Round-trip cost ("phí/vòng") = what you lose buying then immediately selling back:
//   per minute, VWAP of buys / VWAP of sells - 1   (measured inside 1-minute windows so price drift stays small)
// It includes the pool's fee and spread for typical trade sizes (~$100–$1,000) and is the same for every app;
// the Trust Wallet route may add its own small fee on top.
import { rpc, getLogsRange, pool, hex } from './engine.js';

export const FEE_POOL = '0xe6422b4925842725b8aa953571dc03365928a641'; // ANTB/USDT, ~95% of ANTB volume
const SWAP_TOPIC = '0x9734819749a91fc3be03ea83205f924ee08479bd3f0da48efc91d94d050cac1e';
const CACHE_KEY = 'bstocks-fees-v1';
const BLOCKS_PER_HOUR = 8000;   // ~0.45s blocks
const FIRST_LOAD_HOURS = 6;
const KEEP_HOURS = 24;
const STEP = 4000;              // ~3k swaps per query, well under the RPC's 20k result cap

function load() { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c?.v === 1) return c; } catch {} return { v: 1, lastBlock: 0, min: {} }; }
function save(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {} }

const i128 = h => { let v = BigInt('0x' + h); if (v >= 1n << 127n) v -= 1n << 128n; return v; };

// min[minuteTs] = [buyCount, buyUsd, buyAntb, sellCount, sellUsd, sellAntb]
export async function fetchFees({ onProgress = () => {} } = {}) {
  const c = load();
  const head = parseInt(await rpc('eth_blockNumber', []));
  const from = Math.max(c.lastBlock + 1, head - FIRST_LOAD_HOURS * BLOCKS_PER_HOUR);
  const ranges = [];
  for (let f = from; f <= head; f += STEP) ranges.push([f, Math.min(head, f + STEP - 1)]);
  let done = 0;
  onProgress(0, ranges.length);
  await pool(ranges, 3, async ([f, t]) => {
    const logs = await getLogsRange(f, t, FEE_POOL, [SWAP_TOPIC]);
    for (const l of logs) {
      const w = l.data.slice(2 + 64, 2 + 128);             // 2nd word packs int128 ANTB delta | int128 USDT delta (pool side)
      const antb = Number(i128(w.slice(0, 32))) / 1e18, usd = Number(i128(w.slice(32))) / 1e18;
      const ts = parseInt(l.blockTimestamp || 0);
      if (!ts || !antb || Math.abs(usd) < 1) continue;
      const k = Math.floor(ts / 60) * 60;
      const m = c.min[k] ||= [0, 0, 0, 0, 0, 0];
      if (antb < 0) { m[0]++; m[1] += Math.abs(usd); m[2] += -antb; }  // pool paid out ANTB -> user bought
      else { m[3]++; m[4] += Math.abs(usd); m[5] += antb; }            // pool received ANTB -> user sold
    }
    onProgress(++done, ranges.length);
  });
  c.lastBlock = head;
  const cutoff = Date.now() / 1000 - KEEP_HOURS * 3600;
  for (const k of Object.keys(c.min)) if (+k < cutoff) delete c.min[k];
  save(c);
  return { minutes: c.min, fetchedAt: Date.now() };
}

// Group minutes into buckets of `size` minutes. Returns [{ ts, n, usd, rt }] with rt in fraction (0.0001 = 0.01%).
export function bucketize(minutes, size) {
  const out = {};
  for (const [k, m] of Object.entries(minutes)) {
    const b = Math.floor(+k / (size * 60)) * size * 60;
    const o = out[b] ||= { ts: b, n: 0, usd: 0, rtSum: 0, rtW: 0 };
    o.n += m[0] + m[3]; o.usd += m[1] + m[4];
    if (m[0] && m[3] && m[2] && m[5]) {
      const rt = (m[1] / m[2]) / (m[4] / m[5]) - 1;
      const w = Math.min(m[0], m[3]);
      if (Math.abs(rt) < 0.02) { o.rtSum += rt * w; o.rtW += w; } // ignore outliers (>2%), e.g. a big price jump inside one minute
    }
  }
  return Object.values(out).sort((a, b) => a.ts - b.ts).map(o => ({ ts: o.ts, n: o.n, usd: o.usd, rt: o.rtW ? o.rtSum / o.rtW : null }));
}

const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// Current state vs the recent norm: last 15 complete minutes compared with all 5-minute buckets we have.
export function feeStatus(minutes) {
  const now = Math.floor(Date.now() / 60000) * 60;
  const recent = Object.fromEntries(Object.entries(minutes).filter(([k]) => +k >= now - 15 * 60 && +k < now));
  const cur = bucketize(recent, 15)[0] || null;
  const last5 = bucketize(Object.fromEntries(Object.entries(minutes).filter(([k]) => +k >= now - 5 * 60 && +k < now)), 5)[0] || null;
  const b5 = bucketize(minutes, 5).filter(b => b.ts < now - 5 * 60);
  const normRt = median(b5.map(b => b.rt));
  const normN = median(b5.map(b => b.n));
  const ratio = cur?.rt != null && normRt ? cur.rt / normRt : null;
  const level = ratio == null ? 'unknown' : ratio <= 0.85 ? 'low' : ratio >= 1.25 ? 'high' : 'normal';
  return { rt: cur?.rt ?? null, normRt, n5: last5?.n ?? 0, normN, ratio, level };
}
