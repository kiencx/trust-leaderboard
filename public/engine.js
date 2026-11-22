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
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const STABLES = new Set([
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', // FDUSD
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', // USD1
]);
const USEROP_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([s, a]) => [a, s]));
const TOKEN_GROUPS = (() => { const a = Object.values(TOKENS), g = []; for (let i = 0; i < a.length; i += 10) g.push(a.slice(i, i + 10)); return g; })();

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
export async function clearCache() { await idbSet(CACHE_KEY, emptyCache()); }

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
export async function refresh({ extraWallets = [], detailWallet = '', onProgress = () => {} } = {}) {
  const cache = await loadCache();
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

    // Receipts: which contract the tx went to (Trust Wallet route?), stablecoins paid/received, gas paid.
    const walletsByTx = {};
    const Wset = new Set(wallets);
    for (const [tx, , from, to] of Object.values(cache.logs)) for (const w of [from, to]) if (Wset.has(w)) (walletsByTx[tx] ||= new Set()).add(w);
    // The public RPC rate-limits items inside a batch, so retry the ones that came back empty.
    const total = Object.keys(walletsByTx).filter(h => !cache.rx[h]).length;
    for (let round = 0; round < 5; round++) {
      const missing = Object.keys(walletsByTx).filter(h => !cache.rx[h]);
      if (!missing.length) break;
      if (round) await sleep(2000 * round);
      const size = round ? 10 : 20;
      const batches = []; for (let i = 0; i < missing.length; i += size) batches.push(missing.slice(i, i + size));
      await pool(batches, round ? 2 : 3, async b => {
        const res = await rpcBatch(b.map(h => ['eth_getTransactionReceipt', [h]]));
        b.forEach((h, i) => { if (res[i]) cache.rx[h] = digestReceipt(res[i], walletsByTx[h]); });
        step('Đang đọc receipt giao dịch (tiền trả/nhận, gas)', total - Object.keys(walletsByTx).filter(h => !cache.rx[h]).length, total);
      });
      await saveCache(cache);
    }
  } catch (e) {
    saveCache(cache);
    throw new Error(`RPC công khai của BSC đang quá tải (${e.message}). Phần đã quét đã được lưu — bấm Fetch để quét tiếp.`);
  }
  saveCache(cache);

  step('Đang lấy giá token (DexScreener)');
  const price = {};
  const ds = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + [...Object.values(TOKENS), WBNB].join(','), { signal: AbortSignal.timeout(30_000) }).then(r => r.json());
  for (const p of ds) { const a = p.baseToken.address.toLowerCase(); const liq = p.liquidity?.usd || 0; if (!price[a] || liq > price[a].liq) price[a] = { usd: +p.priceUsd, liq }; }
  const bnbUsd = price[WBNB]?.usd || 0;

  // ---------- compute ----------
  const W = new Set(wallets);
  const perTx = {};
  for (const [tx, token, from, to, amount, ts, block] of Object.values(cache.logs)) {
    if (block < cache.startBlock || block > head) continue;
    const qty = Number(BigInt(amount)) / 1e18;
    for (const [w, dir] of [[from, 'out'], [to, 'in']]) if (W.has(w)) (perTx[w + '|' + tx] ||= []).push({ tx, token, ts, block, qty, dir });
  }
  const stats = {}, events = {};
  for (const w of wallets) { stats[w] = { volume: 0, points: 0, swaps: 0, excluded: 0, lastTs: 0, gasUsd: 0, gasBnb: 0, spreadLoss: 0, history: [] }; events[w] = []; }
  for (const [k, legs] of Object.entries(perTx)) {
    const [w, tx] = k.split('|'); const s = stats[w];
    const ins = legs.some(x => x.dir === 'in'), outs = legs.some(x => x.dir === 'out');
    const rx = cache.rx[tx];
    if (ins && outs) { s.excluded++; continue; }                      // bStock -> bStock / self transfer
    if (!rx) s.noReceipt = (s.noReceipt || 0) + 1;                     // receipt not loaded yet: assume Trust Wallet route
    else if (!ALLOWED_TX_TO.has(rx[0])) { s.excluded++; continue; }    // not via the Trust Wallet swap route
    const token = legs[0].token, qty = legs.reduce((a, x) => a + (x.token === token ? x.qty : 0), 0);
    const marketUsd = legs.reduce((a, x) => a + x.qty * (price[x.token]?.usd || 0), 0);
    // Prefer the real stablecoin amount paid/received in this tx; fall back to the current market value.
    const [stable = 0, gasBnb = 0] = rx[1]?.[w] || [];
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
    if (w !== detailWallet.toLowerCase()) { delete stats[w].history; delete stats[w].rounds; } // keep the result small
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
