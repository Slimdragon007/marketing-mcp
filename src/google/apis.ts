import type { GoogleClient } from "./client";

const DATA = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const GSC = "https://www.googleapis.com/webmasters/v3";

export interface KeyEvent {
  name: string;
  eventName: string;
  countingMethod: "ONCE_PER_EVENT" | "ONCE_PER_SESSION";
  createTime?: string;
  deletable?: boolean;
  custom?: boolean;
}

export interface CustomDimension {
  name: string;
  parameterName: string;
  displayName: string;
  description?: string;
  scope: string;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
}

export const ADMIN_RESOURCES = {
  key_events: "keyEvents",
  custom_dimensions: "customDimensions",
  google_ads_links: "googleAdsLinks",
  data_streams: "dataStreams",
} as const;
export type AdminResource = keyof typeof ADMIN_RESOURCES;

const MAX_PAGES = 5;

export async function adminList<T>(g: GoogleClient, propertyId: string, collection: string, access: "read" | "write" = "read") {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
    const body = await g.call<Record<string, unknown> & { nextPageToken?: string }>(
      access,
      "GET",
      `${ADMIN}/properties/${propertyId}/${collection}?${qs}`,
    );
    const list = (body?.[collection] as T[] | undefined) ?? [];
    items.push(...list);
    pageToken = body?.nextPageToken;
    if (!pageToken) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export const ga4 = {
  runReport: (g: GoogleClient, propertyId: string, req: unknown) =>
    g.call<Record<string, unknown>>("read", "POST", `${DATA}/properties/${propertyId}:runReport`, req),
  runRealtimeReport: (g: GoogleClient, propertyId: string, req: unknown) =>
    g.call<Record<string, unknown>>("read", "POST", `${DATA}/properties/${propertyId}:runRealtimeReport`, req),

  findKeyEvent: async (g: GoogleClient, propertyId: string, eventName: string) => {
    const { items } = await adminList<KeyEvent>(g, propertyId, "keyEvents", "write");
    return items.find((k) => k.eventName === eventName) ?? null;
  },
  createKeyEvent: (g: GoogleClient, propertyId: string, eventName: string, countingMethod: KeyEvent["countingMethod"]) =>
    g.call<KeyEvent>("write", "POST", `${ADMIN}/properties/${propertyId}/keyEvents`, { eventName, countingMethod }),
  patchKeyEventCounting: (g: GoogleClient, name: string, countingMethod: KeyEvent["countingMethod"]) =>
    g.call<KeyEvent>("write", "PATCH", `${ADMIN}/${name}?updateMask=countingMethod`, { countingMethod }),
  deleteKeyEvent: (g: GoogleClient, name: string) => g.call<Record<string, never>>("write", "DELETE", `${ADMIN}/${name}`),

  findCustomDimension: async (g: GoogleClient, propertyId: string, parameterName: string) => {
    const { items } = await adminList<CustomDimension>(g, propertyId, "customDimensions", "write");
    return items.find((d) => d.scope === "EVENT" && d.parameterName === parameterName) ?? null;
  },
  createCustomDimension: (
    g: GoogleClient,
    propertyId: string,
    dim: { parameterName: string; displayName: string; description?: string },
  ) => g.call<CustomDimension>("write", "POST", `${ADMIN}/properties/${propertyId}/customDimensions`, { ...dim, scope: "EVENT" }),
};

const site = (s: string) => `${GSC}/sites/${encodeURIComponent(s)}`;

export const gsc = {
  query: (g: GoogleClient, siteUrl: string, req: unknown) =>
    g.call<Record<string, unknown>>("read", "POST", `${site(siteUrl)}/searchAnalytics/query`, req),
  listSitemaps: (g: GoogleClient, siteUrl: string) =>
    g.call<{ sitemap?: Sitemap[] }>("read", "GET", `${site(siteUrl)}/sitemaps`),
  getSitemap: (g: GoogleClient, siteUrl: string, feed: string) =>
    g.call<Sitemap>("write", "GET", `${site(siteUrl)}/sitemaps/${encodeURIComponent(feed)}`, undefined, { allow404: true }),
  submitSitemap: (g: GoogleClient, siteUrl: string, feed: string) =>
    g.call<Record<string, never>>("write", "PUT", `${site(siteUrl)}/sitemaps/${encodeURIComponent(feed)}`),
  deleteSitemap: (g: GoogleClient, siteUrl: string, feed: string) =>
    g.call<Record<string, never>>("write", "DELETE", `${site(siteUrl)}/sitemaps/${encodeURIComponent(feed)}`),
};
