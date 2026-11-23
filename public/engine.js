// bStocks live leaderboard — computed entirely in the browser from BSC on-chain data.
// Only the Trust Wallet leaderboard (wallet list) goes through /api/leaderboard because that API blocks CORS.

export const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com'];
// PublicNode BSC dropped historical log indices below block 135,000,000 (silently returning []).
// Use NodeReal (50k-block range, all 21 tokens in 1 call) + 48.club fallback for blocks below the cutoff.
const ARCHIVE_LOG_RPC = 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3';
const BACKUP_LOG_RPC = 'https://rpc-bsc.48.club';
const PUBLICNODE_MIN_BLOCK = 135_000_000;
const RECEIPT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed3.bnbchain.org',
  'https://bsc-dataseed4.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.defibit.io',
  'https://bsc-dataseed4.defibit.io',
  'https://bsc-dataseed2.ninicoin.io',
  'https://bsc-dataseed3.ninicoin.io',
];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const START_TS = Date.parse('2026-11-20T02:00:00Z') / 1000;
const START_BLOCK = 134_611_490; // exact BSC block at 2026-11-20T02:00:00Z (avoids 22 sequential binary-search RPCs)
export const END_TS = Date.parse('2026-12-04T02:00:00Z') / 1000;
export const QUALIFY_USD = 10_000;
const MIN_TX_USD = 10;
const CHUNK = 25_000; // smaller windows answer faster on PublicNode (max allowed is 50k)
const ARCHIVE_CHUNK = 50_000; // NodeReal supports 50k blocks + all 21 tokens in one eth_getLogs call
const WALLET_GROUP = 300; // PublicNode & NodeReal accept 300+ topic addresses with zero extra latency
const CACHE_KEY = 'bstocks-cache-v2'; // bumped from v1 to discard incomplete PublicNode pre-135M caches

// Trust Wallet swaps observed on-chain go through this router (EOA wallets)
// or through the ERC-4337 EntryPoint v0.7 (Trust Wallet smart accounts).
const ALLOWED_TX_TO = new Set([
  '0x3d90f66b534dd8482b181e24655a9e8265316be9',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
]);

export const TOKENS = {
  ANTB: '0x38dd26788cf2d901e3abf04efe3007d459d0fc53', NVDAB: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
  AMATB: '0xa304bd78e739c0f777202b3eb73ac3736d1df801', DELLB: '0x0e7a51966c66648999d506e1372efdea1b78cb0b',
  BABAB: '0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec', SNDKB: '0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb',
  SOXLB: '0xd97d097a89113fa59b76c572e5b2eb647e8eefaf', MUB: '0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699',
  SKHYB: '0xca750ef65f295bbecd685abf54e82caf297bdb61', GOOGLB: '0x3f53de71c126bdabae20f9cd64848d317f6c3238',
  AAPLB: '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a', MSFTB: '0x80106cb3ead06659a5ad19df39d9b4733863b9b0',
  AMZNB: '0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00', METAB: '0x7425889fe94f9d693e8daefe88bcced6acfef4c0',
  TSLAB: '0x5b1910eaad6450e50f816082aa078c41f10c292f', SPCXB: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',
  MSTRB: '0xe87afb3076aeb0f9b14e368de8145ae6a2826a14', CRCLB: '0x80f3d493ebce97e343c53d29a137942416b4ffc0',
  SNXXB: '0x9e82e3da8f1115b73d24bb24113ab836ffdab6b6', INTCB: '0xe614e2fc6c787035ff51f452e8e826bfd32d5283',
  BNCB: '0x4902c5ebc598265ed2212b559b042de8a5eeec3f',
};
const BOOSTED = new Set([TOKENS.ANTB, TOKENS.NVDAB]);
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const STABLES = new Set([
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', // FDUSD
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', // USD1
]);
const USEROP_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([s, a]) => [a, s]));
const ALL_TOKENS = Object.values(TOKENS);
const TOKEN_GROUPS = (() => { const a = ALL_TOKENS, g = []; for (let i = 0; i < a.length; i += 10) g.push(a.slice(i, i + 10)); return g; })();

// ---------- cache (IndexedDB, per browser; localStorage is too small once receipts are cached) ----------
function emptyCache() { return { v: 1, startBlock: 0, endBlock: 0, scanned: {}, logs: {}, rx: {} }; }
let dbp;
const idb = () => dbp ||= new Promise((res, rej) => {
  const r = indexedDB.open('bstocks', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
export async function idbGet(k) {
  try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  catch { return undefined; }
}
export async function idbSet(k, v) {
  try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  catch { /* storage blocked: keep in memory only */ }
}
export async function loadCache() {
  let c = await idbGet(CACHE_KEY);
  if (!c) { try { c = JSON.parse(localStorage.getItem(CACHE_KEY)); localStorage.removeItem(CACHE_KEY); } catch {} } // migrate old cache
  if (c?.v !== 1) return emptyCache();
  c.rx ||= {}; delete c.txTo;
  for (const h in c.rx) if (!c.rx[h]) delete c.rx[h];
  return c;
}
const saveCache = c => idbSet(CACHE_KEY, c);
let saveTimer = null, saveDirty = false;
function scheduleSave(c) {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; if (saveDirty) { saveDirty = false; saveCache(c); } }, 5000);
}
async function flushSave(c) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveDirty = false;
  await saveCache(c);
}
export async function clearCache() { await idbSet(CACHE_KEY, emptyCache()); }

// ---------- rpc ----------
let rpcId = 0, rpcRR = 0, logRR = 0, batchRR = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function rpc(method, params, attempt = 0) {
  const poolList = attempt < 4 ? RECEIPT_RPCS : RPCS;
  const url = poolList[(rpcRR++) % poolList.length];
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  } catch (e) {
    if (attempt >= 5) throw new Error(`${method}: ${e.message}`);
    await sleep(500 * (attempt + 1));
    return rpc(method, params, attempt + 1);
  }
}
// eth_getLogs with retries; if a range keeps failing (node errors, timeouts, result caps),
// split it in half and query each half separately.
export async function getLogsRange(f, t, address, topics, depth = 0) {
  let lastErr;
  const startIdx = logRR++;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(RPCS[(startIdx + attempt) % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_getLogs', params: [{ fromBlock: hex(f), toBlock: hex(t), address, topics }] }), signal: AbortSignal.timeout(45_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (!Array.isArray(j.result)) throw new Error('invalid getLogs response');
      return j.result;
    } catch (e) {
      lastErr = e;
      if (/max results|exceed|too large|limit/i.test(e.message)) break; // retrying the same range won't help
      await sleep(1500 * (attempt + 1));
    }
  }
  if (t - f < 1000 || depth >= 5) throw new Error('eth_getLogs: ' + lastErr.message);
  const m = (f + t) >> 1;
  const a = await getLogsRange(f, m, address, topics, depth + 1);
  const b = await getLogsRange(m + 1, t, address, topics, depth + 1);
  return a.concat(b);
}
// Archive eth_getLogs for blocks below PublicNode's 135,000,000 log index cutoff:
// primary = NodeReal (up to 50k blocks, all 21 tokens in 1 call), fallback = rpc-bsc.48.club (5k-block sub-chunks).
async function getBackupLogsRange(f, t, address, topics) {
  const subs = [];
  for (let s = f; s <= t; s += 5000) subs.push([s, Math.min(t, s + 4999)]);
  const out = [];
  await pool(subs, 3, async ([sf, st]) => {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(BACKUP_LOG_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_getLogs', params: [{ fromBlock: hex(sf), toBlock: hex(st), address, topics }] }), signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        if (!Array.isArray(j.result)) throw new Error('invalid backup getLogs response');
        out.push(...j.result);
        return;
      } catch (e) { lastErr = e; await sleep(1000 * (attempt + 1)); }
    }
    throw new Error('backup eth_getLogs: ' + lastErr.message);
  });
  return out;
}
async function getArchiveLogsRange(f, t, address, topics, { allowPublicNode = false, depth = 0 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(ARCHIVE_LOG_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_getLogs', params: [{ fromBlock: hex(f), toBlock: hex(t), address, topics }] }), signal: AbortSignal.timeout(35_000) });
      if (r.status === 429) { lastErr = new Error('HTTP 429'); if (allowPublicNode) break; await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (!Array.isArray(j.result)) throw new Error('invalid archive getLogs response');
      return j.result;
    } catch (e) {
      lastErr = e;
      if (/max results|exceed|too large|limit/i.test(e.message)) {
        if (t - f >= 2000 && depth < 4) {
          const m = (f + t) >> 1;
          const a = await getArchiveLogsRange(f, m, address, topics, { allowPublicNode, depth: depth + 1 });
          const b = await getArchiveLogsRange(m + 1, t, address, topics, { allowPublicNode, depth: depth + 1 });
          return a.concat(b);
        }
        break;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  // Fallback: for blocks >= 135M use PublicNode (10-address groups, 25k chunks); for < 135M use 48.club (5k chunks)
  if (allowPublicNode) {
    const out = [];
    const groups = Array.isArray(address) && address.length > 10 ? TOKEN_GROUPS : [address];
    const subs = [];
    for (let s = f; s <= t; s += CHUNK) for (const g of groups) subs.push([s, Math.min(t, s + CHUNK - 1), g]);
    await pool(subs, 3, async ([sf, st, g]) => out.push(...await getLogsRange(sf, st, g, topics)));
    return out;
  }
  return getBackupLogsRange(f, t, address, topics);
}
async function rpcBatch(calls) {
  const startIdx = batchRR++;
  for (let attempt = 0; ; attempt++) {
    const url = attempt < 4 ? RECEIPT_RPCS[(startIdx + attempt) % RECEIPT_RPCS.length] : RPCS[attempt % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))), signal: AbortSignal.timeout(25_000) });
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 200));
      const out = []; for (const x of j) if (x && x.result) out[x.id] = x.result;
      if (calls.length > 0 && out.filter(Boolean).length === 0) throw new Error('empty batch');
      return out;
    } catch (e) { if (attempt >= 4) throw e; await sleep(400 * (attempt + 1)); }
  }
}
export const hex = n => '0x' + n.toString(16);
const pad = a => '0x' + a.slice(2).padStart(64, '0');
async function blockAtTs(ts, head) {
  let lo = head - 3_000_000, hi = head;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const b = await rpc('eth_getBlockByNumber', [hex(mid), false]);
    if (parseInt(b.timestamp) < ts) lo = mid; else hi = mid;
  }
  return hi;
}
export async function pool(items, n, fn) {
  const q = [...items];
  let failed = false;
  await Promise.all(Array.from({ length: n }, async () => {
    while (q.length && !failed) {
      try { await fn(q.shift()); } catch (e) { failed = true; throw e; }
    }
  }));
}

// ---------- main ----------
export async function refresh({ extraWallets = [], detailWallet = '', onProgress = () => {}, onPartial = null } = {}) {
  const cache = await loadCache();
  const step = (stage, done = 0, total = 0) => onProgress({ stage, done, total });
  const detailW = detailWallet.toLowerCase();

  step('Đang tải danh sách ví, giá token & block mới nhất');
  const [official, ds, headHex, pnOk] = await Promise.all([
    fetch('/api/leaderboard', { signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error('API Trust Wallet lỗi ' + r.status); return r.json(); }),
    fetch('https://api.dexscreener.com/tokens/v1/bsc/' + [...Object.values(TOKENS), WBNB].join(','), { signal: AbortSignal.timeout(30_000) }).then(r => r.json()).catch(() => []),
    rpc('eth_blockNumber', []),
    // Verify PublicNode still has logs starting at PUBLICNODE_MIN_BLOCK (future-proof against further pruning)
    fetch(RPCS[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_getLogs', params: [{ fromBlock: hex(PUBLICNODE_MIN_BLOCK), toBlock: hex(PUBLICNODE_MIN_BLOCK + 1000), address: [TOKENS.ANTB], topics: [TRANSFER] }] }), signal: AbortSignal.timeout(10_000) })
      .then(r => r.json()).then(j => Array.isArray(j.result) && j.result.length > 0).catch(() => false),
  ]);
  const officialMap = Object.fromEntries((official.entries || []).map(e => [e.address.toLowerCase(), e]));
  const wallets = [...new Set([...Object.keys(officialMap), ...extraWallets.map(w => w.toLowerCase())])];
  const Wset = new Set(wallets);

  const price = {};
  for (const p of (Array.isArray(ds) ? ds : [])) { const a = p.baseToken?.address?.toLowerCase(); const liq = p.liquidity?.usd || 0; if (a && (!price[a] || liq > price[a].liq)) price[a] = { usd: +p.priceUsd, liq }; }
  const bnbUsd = price[WBNB]?.usd || 0;

  let head = parseInt(headHex) - 3; // ~1.3s safety margin so all RPCs have synced logs & receipts at tip
  const headTs = parseInt((await rpc('eth_getBlockByNumber', [hex(head), false])).timestamp);
  cache.startBlock ||= START_BLOCK;
  if (headTs > END_TS) head = cache.endBlock ||= (await blockAtTs(END_TS, head)) - 1;

  // Compute leaderboard from current cache state (used both for progressive render and final result)
  const computeResult = () => {
    const perTx = {};
    for (const [tx, token, from, to, amount, ts, block] of Object.values(cache.logs)) {
      if (block < cache.startBlock || block > head) continue;
      const qty = Number(BigInt(amount)) / 1e18;
      for (const [w, dir] of [[from, 'out'], [to, 'in']]) if (Wset.has(w)) (perTx[w + '|' + tx] ||= []).push({ tx, token, ts, block, qty, dir });
    }
    const stats = {}, events = {};
    for (const w of wallets) { stats[w] = { volume: 0, points: 0, swaps: 0, excluded: 0, lastTs: 0, gasUsd: 0, gasBnb: 0, spreadLoss: 0, history: [] }; events[w] = []; }
    for (const [k, legs] of Object.entries(perTx)) {
      const [w, tx] = k.split('|'); const s = stats[w];
      const ins = legs.some(x => x.dir === 'in'), outs = legs.some(x => x.dir === 'out');
      const rx = cache.rx[tx];
      if (ins && outs) { s.excluded++; continue; }                      // bStock -> bStock / self transfer
      const token = legs[0].token, qty = legs.reduce((a, x) => a + (x.token === token ? x.qty : 0), 0);
      const marketUsd = legs.reduce((a, x) => a + x.qty * (price[x.token]?.usd || 0), 0);
      if (!rx) {
        if (marketUsd > 0 && marketUsd < 3) { s.excluded++; continue; } // dust tx: skipped receipt fetch
        s.noReceipt = (s.noReceipt || 0) + 1;                           // receipt not loaded yet: assume Trust Wallet route
      } else if (!ALLOWED_TX_TO.has(rx[0])) { s.excluded++; continue; } // not via the Trust Wallet swap route
      // Prefer the real stablecoin amount paid/received in this tx; fall back to the current market value.
      const [stable = 0, gasBnb = 0] = rx?.[1]?.[w] || [];
      const real = ins ? -stable : stable;
      const usd = real > 0 && (!marketUsd || Math.abs(real / marketUsd - 1) < 0.5) ? real : marketUsd;
      if (usd < MIN_TX_USD) { s.excluded++; continue; }
      const mult = BOOSTED.has(token) ? 1.5 : 1;
      const gasUsd = gasBnb * bnbUsd;
      s.volume += usd; s.swaps++; s.points += usd * mult; s.gasUsd += gasUsd; s.gasBnb += gasBnb;
      s.lastTs = Math.max(s.lastTs, legs[0].ts);
      const ev = { tx, ts: legs[0].ts, block: legs[0].block, token, sym: SYMBOL[token], qty, usd, gasUsd, mult, side: ins ? 'Mua' : 'Bán', priced: usd === real };
      s.history.push(ev); events[w].push(ev);
    }

    // Round trips with average cost per token: each sell is matched against the tokens bought during the campaign.
    const BRACKET_MAX = [100, 200, 400, 700, 1000, 2000, 5000, Infinity];
    const bAcc = BRACKET_MAX.map(() => ({ count: 0, spreadSum: 0, spreadN: 0, gasPctSum: 0, gasUsdSum: 0 }));
    for (const w of wallets) {
      const s = stats[w], pos = {}; const rounds = [];
      for (const e of events[w].sort((a, b) => a.block - b.block || a.ts - b.ts)) {
        const p = pos[e.token] ||= { qty: 0, cost: 0, gas: 0 };
        if (e.side === 'Mua') { p.qty += e.qty; p.cost += e.usd; p.gas += e.gasUsd; continue; }
        const matched = Math.min(e.qty, p.qty);
        if (matched <= 1e-12) continue; // selling tokens bought before the campaign: no cost basis
        const share = matched / p.qty, basis = p.cost * share, buyGas = p.gas * share;
        const proceeds = e.usd * matched / e.qty;
        const loss = basis - proceeds;
        const spreadPct = basis ? loss / basis : 0;
        const gasUsd = buyGas + e.gasUsd * matched / e.qty;
        p.qty -= matched; p.cost -= basis; p.gas -= buyGas;
        s.spreadLoss += loss;
        rounds.push({ ts: e.ts, tx: e.tx, token: SYMBOL[e.token], buyUsd: basis, sellUsd: proceeds, loss, spreadPct, gasUsd, points: (basis + proceeds) * e.mult });
        if (basis >= 10) {
          const bi = BRACKET_MAX.findIndex(m => basis < m);
          const acc = bAcc[bi];
          acc.count++;
          acc.gasUsdSum += gasUsd;
          acc.gasPctSum += gasUsd / basis;
          if (spreadPct > 0 && spreadPct < 0.02) { acc.spreadSum += spreadPct; acc.spreadN++; }
        }
      }
      s.feeLost = s.spreadLoss + s.gasUsd;
      s.open = Object.entries(pos).filter(([, p]) => p.qty > 1e-9).map(([t, p]) => ({ token: SYMBOL[t], qty: p.qty, cost: p.cost, gasUsd: p.gas }));
      s.rounds = rounds.reverse();
    }
    const trustBrackets = bAcc.map(a => ({
      count: a.count,
      spreadMean: a.spreadN ? a.spreadSum / a.spreadN : null,
      gasPctMean: a.count ? a.gasPctSum / a.count : null,
      gasUsdSum: a.gasUsdSum,
    }));

    let qRank = 0;
    const rows = wallets.map(w => {
      const o = officialMap[w];
      stats[w].history.sort((a, b) => b.ts - a.ts);
      if (w !== detailW) { delete stats[w].history; delete stats[w].rounds; } // keep the result small
      return { address: o?.address || w, ...stats[w], qualified: stats[w].volume >= QUALIFY_USD, official: o ? { rank: o.rank, volume: +o.volume, points: +o.points } : null };
    }).sort((a, b) => b.points - a.points).map((r, i) => {
      const rewardRank = r.qualified ? ++qRank : null;         // only wallets with >= $10k volume are eligible
      const reward = rewardRank ? rewardFor(rewardRank) : 0;
      return { ...r, rank: i + 1, rewardRank, reward, profit: reward - r.feeLost, costPer1k: r.points ? r.feeLost / r.points * 1000 : 0 };
    });

    return {
      fetchedAt: new Date().toISOString(), headBlock: head, headTime: new Date(Math.min(headTs, END_TS) * 1000).toISOString(),
      officialUpdatedAt: official.last_updated_at, endsAt: new Date(END_TS * 1000).toISOString(), bnbUsd,
      noReceipt: Object.values(stats).reduce((a, s) => a + (s.noReceipt || 0), 0),
      prices: Object.fromEntries(Object.entries(price).filter(([a]) => SYMBOL[a]).map(([a, p]) => [SYMBOL[a], p.usd])), rows, trustBrackets,
    };
  };

  // Scan block windows per wallet group using 50k-block windows with ALL 21 tokens in 1 call (NodeReal primary).
  // Split at PUBLICNODE_MIN_BLOCK so any >=135M window can fall back cleanly to PublicNode on 429,
  // while <135M windows fall back to 48.club (never PublicNode, which has no logs <135M).
  const pnCut = pnOk ? PUBLICNODE_MIN_BLOCK : Infinity;
  const byFrom = {};
  for (const w of wallets) { const from = (cache.scanned[w] ?? cache.startBlock - 1) + 1; if (from <= head) (byFrom[from] ||= []).push(w); }
  const windows = [];
  for (const [fromStr, ws] of Object.entries(byFrom)) {
    const startF = +fromStr;
    for (let i = 0; i < ws.length; i += WALLET_GROUP) {
      const group = { wallets: ws.slice(i, i + WALLET_GROUP), done: new Map(), next: startF };
      const topicAddrs = group.wallets.map(pad);
      if (startF < pnCut) {
        const archEnd = Math.min(head, pnCut - 1);
        for (let f = startF; f <= archEnd; f += ARCHIVE_CHUNK) {
          windows.push({ group, f, t: Math.min(archEnd, f + ARCHIVE_CHUNK - 1), topicAddrs, allowPublicNode: false, remaining: 2, logs: [] });
        }
      }
      if (head >= pnCut) {
        const recStart = Math.max(startF, pnCut);
        for (let f = recStart; f <= head; f += ARCHIVE_CHUNK) {
          windows.push({ group, f, t: Math.min(head, f + ARCHIVE_CHUNK - 1), topicAddrs, allowPublicNode: true, remaining: 2, logs: [] });
        }
      }
    }
  }
  const markDone = win => {
    const g = win.group; g.done.set(win.f, win.t);
    while (g.done.has(g.next)) { const t = g.done.get(g.next); for (const w of g.wallets) cache.scanned[w] = t; g.next = t + 1; }
    scheduleSave(cache);
  };
  const addLogs = (logs, win) => {
    for (const l of logs) {
      const entry = [l.transactionHash, l.address.toLowerCase(), '0x' + l.topics[1].slice(26), '0x' + l.topics[2].slice(26), l.data, parseInt(l.blockTimestamp || 0), parseInt(l.blockNumber)];
      cache.logs[l.transactionHash + ':' + parseInt(l.logIndex)] = entry;
      if (win) win.logs.push(entry);
    }
  };

  // Pipelined receipt fetcher: runs on RECEIPT_RPCS (Binance dataseeds) in parallel with eth_getLogs (PublicNode)
  const walletsByTx = {};
  const queuedTxs = new Set();
  const pendingTxs = [];
  let rxDone = 0, rxTotal = 0, logsFinished = false, aborted = false;

  const enqueueNeededFrom = entries => {
    const perTx = {};
    for (const [tx, token, from, to, amount, , block] of entries) {
      if (block < cache.startBlock || block > head) continue;
      const qty = Number(BigInt(amount)) / 1e18;
      for (const [w, dir] of [[from, 'out'], [to, 'in']]) {
        if (!Wset.has(w)) continue;
        (walletsByTx[tx] ||= new Set()).add(w);
        const rec = (perTx[w + '|' + tx] ||= { tx, ins: false, outs: false, usd: 0 });
        if (dir === 'in') rec.ins = true; else rec.outs = true;
        rec.usd += qty * (price[token]?.usd || 0);
      }
    }
    for (const rec of Object.values(perTx)) {
      if (rec.ins && rec.outs) continue;                // bStock -> bStock / self-transfer
      if (rec.usd > 0 && rec.usd < 3) continue;         // dust (< $3, well under MIN_TX_USD = $10)
      const h = rec.tx;
      if (cache.rx[h] || queuedTxs.has(h)) continue;
      queuedTxs.add(h);
      rxTotal++;
      if (detailW && walletsByTx[h]?.has(detailW)) pendingTxs.unshift(h);
      else pendingTxs.push(h);
    }
  };

  // Enqueue any missing receipts from previously cached logs right away
  enqueueNeededFrom(Object.values(cache.logs));

  const runReceiptWorkers = async () => {
    const BATCH = 45;
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (!aborted) {
        if (pendingTxs.length < BATCH && !logsFinished) { await sleep(120); continue; }
        if (!pendingTxs.length) break;
        const batch = pendingTxs.splice(0, BATCH);
        try {
          const res = await rpcBatch(batch.map(h => ['eth_getTransactionReceipt', [h]]));
          batch.forEach((h, i) => { if (res[i]) { cache.rx[h] = digestReceipt(res[i], walletsByTx[h]); rxDone++; } });
          scheduleSave(cache);
          if (!aborted && logsFinished) step('Đang đọc receipt giao dịch (tiền trả/nhận, gas)', rxDone, rxTotal);
        } catch {
          // Will be picked up by the retry pass below
        }
      }
    }));
  };

  // All windows run through NodeReal (50k blocks, all 21 tokens -> ~12 windows / 24 calls total),
  // with automatic fallback to PublicNode (>=135M) or 48.club (<135M) on 429.
  const logJobs = [];
  for (const win of windows) {
    logJobs.push({ win, g: ALL_TOKENS, topics: [TRANSFER, win.topicAddrs] });
    logJobs.push({ win, g: ALL_TOKENS, topics: [TRANSFER, null, win.topicAddrs] });
  }

  let doneWins = 0;
  try {
    const rxPromise = runReceiptWorkers();
    if (windows.length) {
      step('Đang quét giao dịch on-chain (BSC)', 0, windows.length);
      await pool(logJobs, 2, async j => {
        if (aborted) return;
        const logs = await getArchiveLogsRange(j.win.f, j.win.t, j.g, j.topics, { allowPublicNode: j.win.allowPublicNode });
        addLogs(logs, j.win);
        if (--j.win.remaining === 0) {
          enqueueNeededFrom(j.win.logs);
          j.win.logs = null;
          markDone(j.win);
          if (!aborted) step(`Đang quét giao dịch on-chain (BSC)${rxDone ? ` · đã đọc ${rxDone} receipt` : ''}`, ++doneWins, windows.length);
        }
      });
    }
    // Catch any cross-window / cross-group txs and let receipt workers drain
    enqueueNeededFrom(Object.values(cache.logs));
    logsFinished = true;

    // Show live leaderboard immediately while any remaining receipts finish
    if (onPartial && rxDone < rxTotal) {
      step('Đang đọc receipt giao dịch (tiền trả/nhận, gas)', rxDone, rxTotal);
      onPartial(computeResult());
    }
    await rxPromise;

    // Retry pass for any receipts missed during parallel fetch
    for (let round = 0; round < 3; round++) {
      const missing = [...queuedTxs].filter(h => !cache.rx[h]);
      if (!missing.length) break;
      if (round) await sleep(1000 * round);
      const size = round ? 15 : 25;
      const batches = []; for (let i = 0; i < missing.length; i += size) batches.push(missing.slice(i, i + size));
      await pool(batches, 6, async b => {
        const res = await rpcBatch(b.map(h => ['eth_getTransactionReceipt', [h]]));
        b.forEach((h, i) => { if (res[i]) { cache.rx[h] = digestReceipt(res[i], walletsByTx[h]); rxDone++; } });
        step('Đang đọc receipt giao dịch (tiền trả/nhận, gas)', rxDone, rxTotal);
      });
      await flushSave(cache);
    }
  } catch (e) {
    aborted = true;
    await flushSave(cache);
    throw new Error(`RPC công khai của BSC đang quá tải (${e.message}). Phần đã quét đã được lưu — bấm Fetch để quét tiếp.`);
  }
  await flushSave(cache);

  return computeResult();
}

export const TIERS = [[1, 10000], [2, 6000], [3, 4000], [10, 1500], [20, 750], [50, 400], [100, 250], [200, 215], [300, 160]];
export const rewardFor = rank => (TIERS.find(([max]) => rank <= max) || [0, 0])[1];

// Keep only what we need from a receipt: [txTo, { wallet: [stablecoinDeltaUsd, gasPaidBnb] }]
function digestReceipt(r, walletsInTx) {
  const out = {};
  for (const w of walletsInTx) out[w] = [0, 0];
  for (const l of r.logs) {
    const t0 = l.topics[0];
    if (t0 === TRANSFER && l.topics.length === 3 && STABLES.has(l.address.toLowerCase()) && l.data.length > 2) {
      const from = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26), v = Number(BigInt(l.data)) / 1e18;
      if (out[from]) out[from][0] -= v;
      if (out[to]) out[to][0] += v;
    } else if (t0 === USEROP_EVENT) { // ERC-4337: gas is paid by the smart account (data[2] = actualGasCost)
      const sender = '0x' + l.topics[2].slice(26);
      if (out[sender]) out[sender][1] += Number(BigInt('0x' + l.data.slice(2 + 128, 2 + 192))) / 1e18;
    }
  }
  const from = (r.from || '').toLowerCase();
  if (out[from]) out[from][1] += Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice || 0)) / 1e18;
  for (const w in out) out[w] = out[w].map(x => Math.round(x * 1e9) / 1e9); // keep the cache small
  return [(r.to || '').toLowerCase(), out];
}
