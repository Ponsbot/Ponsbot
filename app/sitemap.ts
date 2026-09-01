import type { MetadataRoute } from "next";

const configuredSiteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.ponsbot.family").trim().replace(/\/+$/, "");
const siteUrl = configuredSiteUrl.startsWith("http") ? configuredSiteUrl : `https://${configuredSiteUrl}`;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, lastModified: new Date(), changeFrequency: "daily", priority: 1 },
    { url: `${siteUrl}/how-it-works`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
  ];
}
