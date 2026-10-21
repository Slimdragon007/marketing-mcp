// Aliases so Claude can say "main" or "shop" instead of remembering ids.
export const GA4_PROPERTIES = {
  main: "100000001",
  shop: "100000002",
} as const;

export const GSC_SITES = {
  main: "https://www.example.com/",
  shop: "https://shop.example.com/",
} as const;

export class InputError extends Error {}

export function resolveProperty(p: string): string {
  if (p in GA4_PROPERTIES) return GA4_PROPERTIES[p as keyof typeof GA4_PROPERTIES];
  const id = p.replace(/^properties\//, "");
  if (!/^\d+$/.test(id)) throw new InputError(`property must be main, shop, or a numeric GA4 property id (got "${p}")`);
  return id;
}

export function resolveSite(s: string): string {
  if (s in GSC_SITES) return GSC_SITES[s as keyof typeof GSC_SITES];
  if (/^sc-domain:[a-z0-9.-]+$/i.test(s)) return s;
  if (/^https:\/\/[^/]+\/$/.test(s)) return s;
  throw new InputError(`site must be main, shop, sc-domain:<host>, or https://<host>/ (got "${s}")`);
}

// A sitemap must live on the site it is submitted to, so a typo cannot point
// Search Console at someone else's host.
export function checkSitemapUrl(site: string, sitemapUrl: string): string {
  let url: URL;
  try {
    url = new URL(sitemapUrl);
  } catch {
    throw new InputError(`sitemap_url is not a URL: "${sitemapUrl}"`);
  }
  if (url.protocol !== "https:") throw new InputError("sitemap_url must be https");
  const host = site.startsWith("sc-domain:") ? site.slice("sc-domain:".length) : new URL(site).host;
  const ok = site.startsWith("sc-domain:") ? url.host === host || url.host.endsWith(`.${host}`) : url.href.startsWith(site);
  if (!ok) throw new InputError(`sitemap_url ${url.href} is not inside site ${site}`);
  return url.href;
}
