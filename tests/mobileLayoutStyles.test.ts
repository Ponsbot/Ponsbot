import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const marker = "/* Mobile containment:";
const overrides = postcss.parse(css.slice(css.indexOf(marker)));

function declarations(selector: string) {
  const result: Record<string, string> = {};
  overrides.walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls((declaration) => { result[declaration.prop] = declaration.value; });
    }
  });
  return result;
}

describe("mobile layout containment", () => {
  it("keeps every override inside the existing phone breakpoint", () => {
    expect(css).toContain(marker);
    let rules = 0;
    overrides.walkRules((rule) => {
      rules += 1;
      expect(rule.parent?.type).toBe("atrule");
      expect(rule.parent).toMatchObject({ name: "media", params: "(max-width:600px)" });
    });
    expect(rules).toBeGreaterThan(0);
  });

  it("wraps token controls instead of pushing them into the artwork or off screen", () => {
    expect(declarations(".detail-link-row")["flex-wrap"]).toBe("wrap");
    expect(declarations(".detail-link-row .detail-actions")["flex-wrap"]).toBe("wrap");
    expect(declarations(".detail-link-row .detail-actions .button")["white-space"]).toBe("normal");
    expect(declarations(".token-market-summary .detail-copy h1")["overflow-wrap"]).toBe("anywhere");
  });

  it("contains long user content and preserves horizontal table scrolling", () => {
    for (const selector of [".terminal-line p", ".holding-balance", ".command-grid code"]) {
      expect(declarations(selector)["overflow-wrap"]).toBe("anywhere");
    }
    expect(declarations(".terminal-chat")["grid-template-columns"]).toBe("minmax(0,1fr) auto");
    expect(declarations(".activity-table-wrap")["max-width"]).toBe("100%");
    overrides.walkDecls((decl) => {
      if (decl.prop.startsWith("overflow")) expect(["hidden", "clip"]).not.toContain(decl.value);
    });
  });

  it("gives swap inputs and large statistics room without clipping", () => {
    expect(declarations(".houdini-amount-row")["grid-template-columns"]).toBe("minmax(0,1fr)");
    expect(declarations(".houdini-privacy-toggle button")["flex-shrink"]).toBe("0");
    expect(declarations(".stats-layout .stats-bubbles .stats-bubble")["flex-wrap"]).toBe("wrap");
    expect(declarations(".stats-layout .stats-bubbles .stats-bubble strong")["white-space"]).toBe("normal");
  });
});
