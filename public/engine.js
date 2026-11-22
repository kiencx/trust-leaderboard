// bStocks live leaderboard — computed entirely in the browser from BSC on-chain data.
// Only the Trust Wallet leaderboard (wallet list) goes through /api/leaderboard because that API blocks CORS.

export const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com'];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const START_TS = Date.parse('2026-11-20T02:00:00Z') / 1000;
export const END_TS = Date.parse('2026-12-04T02:00:00Z') / 1000;
export const QUALIFY_USD = 10_000;
const MIN_TX_USD = 10;
const CHUNK = 25_000; // smaller windows answer faster on the public RPC (max allowed is 50k)
const CACHE_KEY = 'bstocks-cache-v1';

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
const SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([s, a]) => [a, s]));
const TOKEN_GROUPS = (() => { const a = Object.values(TOKENS), g = []; for (let i = 0; i < a.length; i += 10) g.push(a.slice(i, i + 10)); return g; })();

// ---------- cache (localStorage, per browser) ----------
function emptyCache() { return { v: 1, startBlock: 0, endBlock: 0, scanned: {}, logs: {}, txTo: {} }; }
export function loadCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c?.v === 1) return c; } catch {}
  return emptyCache();
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* quota or blocked storage: keep in memory only */ }
}
export function clearCache() { try { localStorage.removeItem(CACHE_KEY); } catch {} }

// ---------- rpc ----------
let rpcId = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function rpc(method, params, attempt = 0) {
  try {
    const r = await fetch(RPCS[attempt % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(40_000) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  } catch (e) {
    if (attempt >= 5) throw new Error(`${method}: ${e.message}`);
    await sleep(1000 * (attempt + 1));
    return rpc(method, params, attempt + 1);
  }
}
// eth_getLogs with retries; if a range keeps failing (node errors, timeouts, result caps),
// split it in half and query each half separately.
export async function getLogsRange(f, t, address, topics, depth = 0) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(RPCS[attempt % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_getLogs', params: [{ fromBlock: hex(f), toBlock: hex(t), address, topics }] }), signal: AbortSignal.timeout(45_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      lastErr = e;
      if (/max results|exceed|too large|limit/i.test(e.message)) break; // retrying the same range won't help
      await sleep(1500 * (attempt + 1));
    }
  }
  if (t - f < 2000 || depth >= 4) throw new Error('eth_getLogs: ' + lastErr.message);
  const m = (f + t) >> 1;
  const a = await getLogsRange(f, m, address, topics, depth + 1);
  const b = await getLogsRange(m + 1, t, address, topics, depth + 1);
  return a.concat(b);
}
async function rpcBatch(calls) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPCS[attempt % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))), signal: AbortSignal.timeout(60_000) });
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 200));
      const out = []; for (const x of j) out[x.id] = x.result; return out;
    } catch (e) { if (attempt >= 4) throw e; await sleep(1000 * (attempt + 1)); }
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
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); }));
}

// ---------- main ----------
export async function refresh({ extraWallets = [], onProgress = () => {} } = {}) {
  const cache = loadCache();
  const step = (stage, done = 0, total = 0) => onProgress({ stage, done, total });

  step('Đang lấy danh sách ví chính thức');
  const official = await fetch('/api/leaderboard', { signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error('API Trust Wallet lỗi ' + r.status); return r.json(); });
  const officialMap = Object.fromEntries((official.entries || []).map(e => [e.address.toLowerCase(), e]));
  const wallets = [...new Set([...Object.keys(officialMap), ...extraWallets.map(w => w.toLowerCase())])];

  step('Đang lấy block mới nhất');
  let head = parseInt(await rpc('eth_blockNumber', []));
  const headTs = parseInt((await rpc('eth_getBlockByNumber', [hex(head), false])).timestamp);
  if (!cache.startBlock) { step('Đang tìm block bắt đầu chiến dịch'); cache.startBlock = await blockAtTs(START_TS, head); }
  if (headTs > END_TS) head = cache.endBlock ||= (await blockAtTs(END_TS, head)) - 1;

  // Scan block windows per wallet group. Progress is saved after every finished window,
  // so if the public RPC fails midway, the next Fetch continues where this one stopped.
  const byFrom = {};
  for (const w of wallets) { const from = (cache.scanned[w] ?? cache.startBlock - 1) + 1; if (from <= head) (byFrom[from] ||= []).push(w); }
  const windows = [];
  for (const [fromStr, ws] of Object.entries(byFrom)) {
    for (let i = 0; i < ws.length; i += 100) {
      const group = { wallets: ws.slice(i, i + 100), done: new Set(), next: +fromStr };
      const topicAddrs = group.wallets.map(pad);
      for (let f = +fromStr; f <= head; f += CHUNK) windows.push({ group, f, t: Math.min(head, f + CHUNK - 1), topicAddrs });
    }
  }
  const markDone = win => {
    const g = win.group; g.done.add(win.f);
    while (g.done.has(g.next)) { const t = Math.min(head, g.next + CHUNK - 1); for (const w of g.wallets) cache.scanned[w] = t; g.next = t + 1; }
    saveCache(cache);
  };
  const addLogs = logs => {
    for (const l of logs) cache.logs[l.transactionHash + ':' + parseInt(l.logIndex)] = [
      l.transactionHash, l.address.toLowerCase(), '0x' + l.topics[1].slice(26), '0x' + l.topics[2].slice(26), l.data, parseInt(l.blockTimestamp || 0), parseInt(l.blockNumber),
    ];
  };
  let done = 0;
  try {
    step('Đang quét giao dịch on-chain (BSC)', 0, windows.length);
    await pool(windows, 2, async win => {
      const jobs = TOKEN_GROUPS.flatMap(g => [[TRANSFER, win.topicAddrs], [TRANSFER, null, win.topicAddrs]].map(topics => ({ g, topics })));
      await pool(jobs, 3, async j => addLogs(await getLogsRange(win.f, win.t, j.g, j.topics)));
      markDone(win);
      step('Đang quét giao dịch on-chain (BSC)', ++done, windows.length);
    });

    const missing = [...new Set(Object.values(cache.logs).map(l => l[0]))].filter(h => !(h in cache.txTo));
    const batches = []; for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
    done = 0;
    step('Đang kiểm tra router của giao dịch', 0, batches.length);
    await pool(batches, 3, async b => {
      const res = await rpcBatch(b.map(h => ['eth_getTransactionByHash', [h]]));
      b.forEach((h, i) => { if (res[i]) cache.txTo[h] = (res[i].to || '').toLowerCase(); });
      step('Đang kiểm tra router của giao dịch', ++done, batches.length);
    });
  } catch (e) {
    saveCache(cache);
    throw new Error(`RPC công khai của BSC đang quá tải (${e.message}). Phần đã quét đã được lưu — bấm Fetch để quét tiếp.`);
  }
  saveCache(cache);

  step('Đang lấy giá token (DexScreener)');
  const price = {};
  const ds = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + Object.values(TOKENS).join(','), { signal: AbortSignal.timeout(30_000) }).then(r => r.json());
  for (const p of ds) { const a = p.baseToken.address.toLowerCase(); const liq = p.liquidity?.usd || 0; if (!price[a] || liq > price[a].liq) price[a] = { usd: +p.priceUsd, liq }; }

  // ---------- compute ----------
  const W = new Set(wallets);
  const perTx = {};
  for (const [tx, token, from, to, amount, ts, block] of Object.values(cache.logs)) {
    if (block < cache.startBlock || block > head) continue;
    const usd = Number(BigInt(amount)) / 1e18 * (price[token]?.usd || 0);
    for (const [w, dir] of [[from, 'out'], [to, 'in']]) if (W.has(w)) (perTx[w + '|' + tx] ||= []).push({ tx, token, ts, usd, dir });
  }
  const stats = {};
  for (const w of wallets) stats[w] = { volume: 0, points: 0, swaps: 0, excluded: 0, lastTs: 0, history: [] };
  for (const [k, legs] of Object.entries(perTx)) {
    const [w, tx] = k.split('|'); const s = stats[w];
    const ins = legs.some(x => x.dir === 'in'), outs = legs.some(x => x.dir === 'out');
    if (ins && outs) { s.excluded++; continue; }                     // bStock -> bStock / self transfer
    if (!ALLOWED_TX_TO.has(cache.txTo[tx])) { s.excluded++; continue; } // not via the Trust Wallet swap route
    const usd = legs.reduce((a, x) => a + x.usd, 0);
    if (usd < MIN_TX_USD) { s.excluded++; continue; }
    s.volume += usd; s.swaps++;
    s.points += legs.reduce((a, x) => a + x.usd * (BOOSTED.has(x.token) ? 1.5 : 1), 0);
    s.lastTs = Math.max(s.lastTs, legs[0].ts);
    s.history.push({ tx, ts: legs[0].ts, token: SYMBOL[legs[0].token], side: ins ? 'Mua' : 'Bán', usd });
  }
  const rows = wallets.map(w => {
    const o = officialMap[w];
    stats[w].history.sort((a, b) => b.ts - a.ts);
    return { address: o?.address || w, ...stats[w], qualified: stats[w].volume >= QUALIFY_USD, official: o ? { rank: o.rank, volume: +o.volume, points: +o.points } : null };
  }).sort((a, b) => b.points - a.points).map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    fetchedAt: new Date().toISOString(), headBlock: head, headTime: new Date(Math.min(headTs, END_TS) * 1000).toISOString(),
    officialUpdatedAt: official.last_updated_at, endsAt: new Date(END_TS * 1000).toISOString(),
    prices: Object.fromEntries(Object.entries(price).map(([a, p]) => [SYMBOL[a], p.usd])), rows,
  };
}
