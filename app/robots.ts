import type { MetadataRoute } from "next";

const configuredSiteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.ponsbot.family").trim().replace(/\/+$/, "");
const siteUrl = configuredSiteUrl.startsWith("http") ? configuredSiteUrl : `https://${configuredSiteUrl}`;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
