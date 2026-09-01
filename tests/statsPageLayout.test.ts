import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(process.cwd(), "app/stats/page.tsx"), "utf8");
const css = postcss.parse(readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8"));

function desktopDeclaration(selector: string, property: string) {
  let value: string | undefined;
  css.walkRules((rule) => {
    if (rule.parent?.type === "root" && rule.selectors.includes(selector)) {
      rule.walkDecls(property, (declaration) => { value = declaration.value; });
    }
  });
  return value;
}

describe("stats page burn section", () => {
  it("uses the requested page title and an accessible burn heading", () => {
    expect(page).toContain('title: "Pons Bot Stats"');
    expect(page).toContain("<h1>Pons Bot Stats</h1>");
    expect(page).toContain('aria-labelledby="stats-burns-heading"');
    expect(page).toContain('<h2 id="stats-burns-heading">$PONSBOT Burned</h2>');
  });

  it("keeps burns after the platform totals, automatic before total, including loading labels", () => {
    expect(page.indexOf("<PlatformTotals />")).toBeLessThan(page.indexOf('className="stats-burns"'));
    expect(page.indexOf("<BurnTotal automatic />")).toBeLessThan(page.indexOf("<BurnTotal />"));
    expect(page).toContain('<StatLine label="Automatically From Creator Fees" value="—" />');
    expect(page).toContain('<StatLine label="Total" value="—" />');
    expect(page).toContain('automatic ? "Automatically From Creator Fees" : "Total"');
  });

  it("stacks sections and places the two burn boxes below a full-width heading", () => {
    expect(desktopDeclaration(".stats-layout", "grid-template-columns")).toBe("minmax(0,1fr)");
    expect(desktopDeclaration(".stats-burns", "grid-template-columns")).toBe("repeat(2,minmax(0,1fr))");
    expect(desktopDeclaration(".stats-burns>h2", "grid-column")).toBe("1/-1");
    expect(desktopDeclaration(".stats-burns", "grid-row")).toBeUndefined();
    expect(desktopDeclaration(".stats-layout>.stats-bubbles", "grid-template-rows")).toBeUndefined();
  });

  it("centers a narrower stats layout and aligns its heading", () => {
    expect(desktopDeclaration(".stats-layout", "max-width")).toBe("1120px");
    expect(desktopDeclaration(".stats-layout", "margin")).toBe("34px auto 0");
    expect(desktopDeclaration(".stats-heading", "max-width")).toBe("1120px");
    expect(desktopDeclaration(".stats-heading", "margin-inline")).toBe("auto");
    expect(desktopDeclaration(".stats-heading", "text-align")).toBe("center");
  });

  it("matches both section headings' typography and centers them on desktop and mobile", () => {
    for (const property of ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "text-align"]) {
      const generated = desktopDeclaration(".stats-generated-banner", property);
      expect(generated).toBeDefined();
      expect(desktopDeclaration(".stats-burns>h2", property)).toBe(generated);
    }
    expect(desktopDeclaration(".stats-burns>h2", "text-align")).toBe("center");
    const mobileSizes: Record<string, string> = {};
    css.walkAtRules("media", (media) => {
      if (media.params !== "(max-width:700px)") return;
      media.walkRules((rule) => {
        for (const selector of [".stats-generated-banner", ".stats-burns>h2"]) {
          if (rule.selectors.includes(selector)) {
            rule.walkDecls("font-size", (decl) => { mobileSizes[selector] = decl.value; });
          }
        }
      });
    });
    expect(mobileSizes[".stats-generated-banner"]).toBe("18px");
    expect(mobileSizes[".stats-burns>h2"]).toBe("18px");
  });

  it("labels historical creator fees and does not display an old mark-to-market total", () => {
    expect(page).toContain('<StatLine label="Creator Fees" value={stats?.feeValuationVersion === 1 ? formatUsd(stats.feesClaimedUsd) : "—"} />');
    expect(page).not.toContain('label="Fees Claimed"');
  });

  it("puts burn labels and values side by side with space for long labels", () => {
    expect(desktopDeclaration(".stats-burns .stats-bubble", "flex-direction")).toBe("row");
    expect(desktopDeclaration(".stats-burns .stats-bubble", "align-items")).toBe("center");
    expect(desktopDeclaration(".stats-burns .stats-bubble", "justify-content")).toBe("space-between");
    expect(desktopDeclaration(".stats-burns .stats-bubble strong", "text-align")).toBe("right");
    expect(desktopDeclaration(".stats-burns .stats-bubble strong", "max-width")).toBe("65%");
    expect(desktopDeclaration(".stats-burns .stats-bubble>span", "min-width")).toBe("0");
    expect(desktopDeclaration(".stats-burns .stats-bubble>span", "overflow-wrap")).toBe("anywhere");
  });
});
