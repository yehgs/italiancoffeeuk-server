// Approximate "same site" test (registrable domain), enough to tell whether the website and the
// API are on the same site. Ports and schemes are ignored, like browsers do for SameSite.
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'com.ng', 'org.ng', 'com.au', 'co.za', 'co.nz', 'co.in', 'com.br',
  'run.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'vercel.app', 'netlify.app', 'herokuapp.com',
]);

export function siteOf(host) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h; // ip / localhost / ipv6
  const parts = h.split('.');
  const take = TWO_PART_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/** True when a browser request from `origin` to `apiHost` is cross-site (cookies need SameSite=None). */
export function isCrossSite(origin, apiHost) {
  if (!origin) return false;
  try {
    return siteOf(new URL(origin).hostname) !== siteOf(apiHost);
  } catch {
    return false;
  }
}
