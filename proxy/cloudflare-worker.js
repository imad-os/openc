// Optional CORS proxy for the web_fetch tool (free Cloudflare Worker).
// Deploy: dash.cloudflare.com → Workers → Create → paste this → Deploy.
// Then in Ollama Code: Settings → Internet → CORS proxy = https://<name>.<you>.workers.dev/?url={url}
// Set ALLOWED_ORIGIN to your app's origin so others can't use your proxy.
const ALLOWED_ORIGIN = 'https://imad-os.github.io';

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') || '';
    const cors = { 'access-control-allow-origin': origin === ALLOWED_ORIGIN || origin.startsWith('http://localhost') ? origin : ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET, OPTIONS', vary: 'origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//.test(target)) return new Response('missing ?url=', { status: 400, headers: cors });
    const res = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (OllamaCode web_fetch)', accept: 'text/html,text/plain,application/json,*/*' }, redirect: 'follow' });
    const headers = new Headers(cors);
    headers.set('content-type', res.headers.get('content-type') || 'text/plain');
    return new Response(res.body, { status: res.status, headers });
  },
};
