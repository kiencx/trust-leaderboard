// Vercel serverless function: proxies the Trust Wallet leaderboard API (which blocks browser CORS).
// Cached at Vercel's edge for 60s so many visitors only cause ~1 upstream request per minute.
export default async function handler(req, res) {
  try {
    const r = await fetch('https://api.trustwallet.com/v1/campaigns/bstocks/leaderboard', { signal: AbortSignal.timeout(20_000) });
    const body = await r.text();
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error: ' + e.message });
  }
}
