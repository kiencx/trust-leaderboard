// Live on-chain Bid / Ask quotes for ANTB & NVDAB read directly from Metric PMM pools on BSC
// (getSellAndBuyPrices() -> UQ64.64), overlaid with real executed swaps across all routers.

import { rpc, getLogsRange, hex, TOKENS } from './engine.js';

const FAST_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed3.bnbchain.org',
  'https://bsc-dataseed4.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.defibit.io',
  'https://bsc-dataseed4.defibit.io',
];
const HIST_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com'];

const USDT = '0x55d398326f99059ff775485246999027b3197955';
const SEL_PRICES = '0xec069057'; // getSellAndBuyPrices() -> (uint256 sellPriceX64, uint256 buyPriceX64)
const SWAP_PMM = '0x9734819749a91fc3be03ea83205f924ee08479bd3f0da48efc91d94d050cac1e';
const SWAP_V3 = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const Q64 = 2 ** 64;

// Verified Metric PMM pools (token0 = bStock, token1 = USDT) supporting getSellAndBuyPrices()
export const QUOTE_POOLS = {
  ANTB: [
    '0xe6422b4925842725b8aa953571dc03365928a641',
    '0xdfef5968703b7200aabe76c39e1391e2a5098c64',
    '0x010fb01c2e714101d199524641fd8bab63966df6',
  ],
  NVDAB: ['0x720117a6d678ef37cf9792df051da87f5809d117'],
};

// Main PancakeSwap V3 bStock-USDT pools to also capture swaps routed outside Metric PMM
const V3_POOLS = {
  ANTB: ['0x5afb6e189a268c6adfc9da13ca13e3ba91171a31'],
  NVDAB: ['0x8fb4243b553ac29ba088acf00b9b7da24bd6690c'],
};

let fastRR = 0, histRR = 0, qId = 0;

const i128 = h => { let v = BigInt('0x' + h); if (v >= 1n << 127n) v -= 1n << 127n; return v; };
const i256 = h => { let v = BigInt('0x' + h); if (v >= 1n << 255n) v -= 1n << 256n; return v; };

function decodeQuote(raw) {
  if (!raw || typeof raw !== 'string' || raw.length < 130) return null;
  const bid = Number(BigInt('0x' + raw.slice(2, 66))) / Q64;
  const ask = Number(BigInt('0x' + raw.slice(66, 130))) / Q64;
  if (!(bid > 0) || !(ask > 0) || ask < bid * 0.9 || ask > bid * 1.2) return null;
  return { bid, ask };
}

async function fastCall(to, data, blockTag = 'latest') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = FAST_RPCS[(fastRR++) % FAST_RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++qId, method: 'eth_call', params: [{ to, data }, blockTag] }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json();
      if (j.result) return j.result;
    } catch {}
  }
  return null;
}

// Combine quotes across active liquid PMM pools (routers pick max bid & min ask for ~$1,000 swaps)
function combinePoolQuotes(quotes) {
  const valid = quotes.filter(Boolean);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  const bestBid = Math.max(...valid.map(q => q.bid));
  const bestAsk = Math.min(...valid.map(q => q.ask));
  if (bestAsk > bestBid) return { bid: bestBid, ask: bestAsk };
  return valid.reduce((best, q) => ((q.ask - q.bid) < (best.ask - best.bid) ? q : best));
}

async function histBatchQuotes(pools, blocks) {
  const calls = [];
  for (const b of blocks) for (const p of pools) calls.push([b, p]);
  const CHUNK = 45;
  const chunks = [];
  for (let i = 0; i < calls.length; i += CHUNK) chunks.push(calls.slice(i, i + CHUNK));
  const perBlock = new Map();
  await Promise.all(chunks.map(async ch => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = HIST_RPCS[(histRR + attempt) % HIST_RPCS.length];
      histRR++;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ch.map(([b, p], id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: p, data: SEL_PRICES }, hex(b)] }))),
          signal: AbortSignal.timeout(12_000),
        });
        const j = await r.json();
        if (!Array.isArray(j)) continue;
        for (const x of j) {
          const q = decodeQuote(x?.result);
          if (!q) continue;
          const [b] = ch[x.id];
          let arr = perBlock.get(b);
          if (!arr) { arr = []; perBlock.set(b, arr); }
          arr.push(q);
        }
        return;
      } catch {}
    }
  }));
  const out = new Map();
  for (const [b, arr] of perBlock) {
    const c = combinePoolQuotes(arr);
    if (c) out.set(b, c);
  }
  return out;
}

// Keep all Metric PMM pools that have >= $800 liquidity on BOTH sides so ~$1,000 swaps can fill
async function resolveActivePools(sym) {
  const list = QUOTE_POOLS[sym];
  if (!list?.length) return [];
  if (list.length === 1) return list;
  const tok = TOKENS[sym];
  const checks = await Promise.all(list.map(async p => {
    const pad = p.slice(2).padStart(64, '0');
    const [bUsdt, bTok, rawQ] = await Promise.all([
      fastCall(USDT, '0x70a08231' + pad),
      fastCall(tok, '0x70a08231' + pad),
      fastCall(p, SEL_PRICES),
    ]);
    const usdt = bUsdt ? Number(BigInt(bUsdt)) / 1e18 : 0;
    const q = decodeQuote(rawQ);
    const tokUsd = bTok && q ? (Number(BigInt(bTok)) / 1e18) * q.bid : 0;
    return { p, usdt, tokUsd, ok: usdt >= 800 && tokUsd >= 800 };
  }));
  const liquid = checks.filter(c => c.ok).map(c => c.p);
  if (liquid.length) return liquid;
  checks.sort((a, b) => (b.usdt + b.tokUsd) - (a.usdt + a.tokUsd));
  return [checks[0].p];
}

// Decode executed swaps across Metric PMM + PancakeSwap V3 pools
async function fetchSwapsRange(sym, fromBlock, toBlock) {
  const tok = TOKENS[sym];
  if (!tok || fromBlock > toBlock) return [];
  const pmmList = QUOTE_POOLS[sym] || [];
  const v3List = V3_POOLS[sym] || [];
  const pmmSet = new Set(pmmList);
  const v3Set = new Set(v3List);
  const tokIs0InV3 = tok < USDT; // PancakeSwap V3 sorts token0 < token1 by address

  const byTx = new Map();
  const allPools = [...pmmList, ...v3List];
  if (!allPools.length) return [];

  const logs = await getLogsRange(fromBlock, toBlock, allPools, [[SWAP_PMM, SWAP_V3]]);
  for (const l of logs) {
    const addr = l.address.toLowerCase();
    const t0 = l.topics[0];
    let dTok = 0, dUsd = 0;
    if (t0 === SWAP_PMM && pmmSet.has(addr) && l.data.length >= 130) {
      const w = l.data.slice(2 + 64, 2 + 128);
      dTok = Number(i128(w.slice(0, 32))) / 1e18;
      dUsd = Number(i128(w.slice(32, 64))) / 1e18;
    } else if (t0 === SWAP_V3 && v3Set.has(addr) && l.data.length >= 130) {
      const a0 = Number(i256(l.data.slice(2, 66))) / 1e18;
      const a1 = Number(i256(l.data.slice(66, 130))) / 1e18;
      dTok = tokIs0InV3 ? a0 : a1;
      dUsd = tokIs0InV3 ? a1 : a0;
    }
    if (!dTok || !dUsd) continue;
    const rec = byTx.get(l.transactionHash) || { tx: l.transactionHash, ts: parseInt(l.blockTimestamp || 0), block: parseInt(l.blockNumber), dTok: 0, dUsd: 0 };
    rec.dTok += dTok;
    rec.dUsd += dUsd;
    if (!rec.ts && l.blockTimestamp) rec.ts = parseInt(l.blockTimestamp);
    byTx.set(l.transactionHash, rec);
  }

  const swaps = [];
  for (const r of byTx.values()) {
    const absUsd = Math.abs(r.dUsd), absTok = Math.abs(r.dTok);
    if (absUsd < 5 || absTok <= 0 || r.dTok * r.dUsd >= 0) continue; // ignore dust (<$5) or same-sign ops
    const side = r.dTok < 0 ? 'buy' : 'sell';
    swaps.push({ tx: r.tx, ts: r.ts, block: r.block, side, price: absUsd / absTok, usd: absUsd, qty: absTok });
  }
  return swaps.sort((a, b) => a.block - b.block || a.ts - b.ts);
}

export function createQuoteFeed(sym = 'ANTB') {
  const state = {
    sym,
    pools: [],
    points: [],     // [{ ts, bid, ask }]
    swaps: [],      // [{ tx, ts, block, side, price, usd, qty }]
    seenTx: new Set(),
    lastSwapBlock: 0,
    tickCount: 0,
  };

  const KEEP_SEC = 20 * 60;

  function trim(nowSec) {
    const cut = nowSec - KEEP_SEC;
    while (state.points.length > 2 && state.points[1].ts < cut) state.points.shift();
    state.swaps = state.swaps.filter(s => !s.ts || s.ts >= nowSec - 60 * 60);
  }

  function mergeSwaps(list, fallbackTs) {
    for (const s of list) {
      if (state.seenTx.has(s.tx)) continue;
      if (!s.ts) s.ts = fallbackTs;
      state.seenTx.add(s.tx);
      state.swaps.push(s);
    }
    state.swaps.sort((a, b) => a.ts - b.ts || a.block - b.block);
  }

  async function init() {
    const head = parseInt(await rpc('eth_blockNumber', []));
    const backBlocks = 670; // ~5 minutes at ~0.45s/block
    const startBlk = Math.max(1, head - backBlocks);

    const [headBlkObj, startBlkObj, activePools, recentSwaps] = await Promise.all([
      rpc('eth_getBlockByNumber', [hex(head), false]),
      rpc('eth_getBlockByNumber', [hex(startBlk), false]),
      resolveActivePools(sym),
      fetchSwapsRange(sym, Math.max(1, head - 2800), head).catch(() => []),
    ]);

    const headTs = parseInt(headBlkObj.timestamp);
    const startTs = parseInt(startBlkObj.timestamp);
    state.pools = activePools;
    state.lastSwapBlock = head;
    mergeSwaps(recentSwaps, headTs);

    if (activePools.length) {
      const sampleCount = activePools.length > 1 ? 84 : 112;
      const sampleBlocks = [];
      const step = Math.max(1, Math.round(backBlocks / sampleCount));
      for (let b = startBlk; b < head; b += step) sampleBlocks.push(b);
      sampleBlocks.push(head);

      const qMap = await histBatchQuotes(activePools, sampleBlocks);
      const spanBlk = Math.max(1, head - startBlk);
      const spanTs = Math.max(1, headTs - startTs);
      const pts = [];
      for (const b of sampleBlocks) {
        const q = qMap.get(b);
        if (!q) continue;
        const ts = Math.round((startTs + ((b - startBlk) / spanBlk) * spanTs) * 10) / 10;
        pts.push({ ts, bid: q.bid, ask: q.ask });
      }
      state.points = pts;
    }
    return snapshot();
  }

  async function tick() {
    const nowSec = Date.now() / 1000;
    state.tickCount++;

    if (state.pools.length) {
      const raws = await Promise.all(state.pools.map(p => fastCall(p, SEL_PRICES, 'latest')));
      const q = combinePoolQuotes(raws.map(decodeQuote));
      if (q) state.points.push({ ts: nowSec, bid: q.bid, ask: q.ask });
    }

    // Refresh executed swaps every 4th tick (~6 seconds)
    if (state.tickCount % 4 === 0) {
      try {
        const head = parseInt(await rpc('eth_blockNumber', []));
        if (head > state.lastSwapBlock) {
          const fresh = await fetchSwapsRange(sym, state.lastSwapBlock + 1, head);
          state.lastSwapBlock = head;
          if (fresh.length) mergeSwaps(fresh, Math.floor(nowSec));
        }
      } catch {}
    }

    trim(nowSec);
    return snapshot();
  }

  function snapshot() {
    const cur = state.points[state.points.length - 1] || null;
    let lastBuy = null, lastSell = null;
    for (let i = state.swaps.length - 1; i >= 0; i--) {
      const s = state.swaps[i];
      if (!lastBuy && s.side === 'buy') lastBuy = s;
      if (!lastSell && s.side === 'sell') lastSell = s;
      if (lastBuy && lastSell) break;
    }
    return {
      sym: state.sym,
      pool: state.pools[0] || null,
      points: state.points,
      swaps: state.swaps,
      current: cur,
      lastBuy,
      lastSell,
    };
  }

  return { init, tick, snapshot };
}
