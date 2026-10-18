/* Cloudflare Pages Functions: the website's pages come from Cloudflare (free, unlimited data);
   only the AI Inbox (/api/...) and the Claude connector (/mcp/...) are passed on to the small
   Node server on Render. Set RENDER_ORIGIN in Cloudflare → Settings → Variables if the Render
   address is different from the default below. */
export async function toRender(context) {
  const origin = (context.env && context.env.RENDER_ORIGIN) || 'https://nirman-app.onrender.com';
  const url = new URL(context.request.url);
  const target = origin.replace(/\/+$/, '') + url.pathname + url.search;
  const headers = new Headers(context.request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', url.host);
  const init = { method: context.request.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(context.request.method)) init.body = context.request.body;
  try {
    const r = await fetch(target, init);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'AI Inbox server not reachable' }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
