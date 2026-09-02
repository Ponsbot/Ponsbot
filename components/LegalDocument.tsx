import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export type LegalSection = { title: string; paragraphs?: string[]; bullets?: string[] };

export function LegalDocument({ eyebrow, title, summary, sections }: { eyebrow: string; title: string; summary: string; sections: LegalSection[] }) {
  return <main><SiteHeader /><article className="legal-page">
    <Link className="back-link" href="/">← Home</Link>
    <header className="legal-hero"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{summary}</p></header>
    <div className="legal-sections">{sections.map((section, index) => <section key={section.title}><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{section.title}</h2>{section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}{section.bullets && <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}</div></section>)}</div>
  </article><SiteFooter /></main>;
}
