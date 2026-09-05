import { describe, expect, it } from "vitest";

import { createRecord, type MemoryRecord } from "#public/memory/learning/record.js";
import {
  activeDirectives,
  applyPromotionPolicy,
  directiveStatus,
  formatDirectives,
  resolvePromotionPolicy,
  withApproval,
  withStatus,
} from "#public/self-improvement/directive.js";

const NOW = Date.UTC(2026, 8, 1);

function directive(text: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    ...createRecord({ kind: "directive", text }, NOW, text.slice(0, 8)),
    ...overrides,
  };
}

describe("directive status", () => {
  it("treats an untagged directive as a candidate", () => {
    expect(directiveStatus(directive("always run tests first"))).toBe("candidate");
  });

  it("replaces a status rather than accumulating tags", () => {
    const active = withStatus(withStatus(directive("x"), "active"), "retired");

    expect(directiveStatus(active)).toBe("retired");
    expect(active.tags?.filter((tag) => tag.startsWith("status:"))).toHaveLength(1);
  });
});

describe("resolvePromotionPolicy", () => {
  it("defaults to human review", () => {
    expect(resolvePromotionPolicy()).toEqual({
      activationConfidence: 0.85,
      mode: "review",
      retirementConfidence: 0.3,
    });
  });

  it("rejects thresholds that cannot both be met", () => {
    expect(() =>
      resolvePromotionPolicy({ activationConfidence: 0.2, retirementConfidence: 0.5 }),
    ).toThrow(/greater than retirementConfidence/);
  });
});

describe("applyPromotionPolicy", () => {
  it("never activates on confidence alone under review", () => {
    const policy = resolvePromotionPolicy();
    const records = [directive("always deploy from main", { confidence: 1 })];

    expect(directiveStatus(applyPromotionPolicy(records, policy)[0]!)).toBe("candidate");
  });

  it("activates an approved candidate under review", () => {
    const policy = resolvePromotionPolicy();
    const records = [withApproval(directive("always deploy from main", { confidence: 0.4 }))];

    expect(directiveStatus(applyPromotionPolicy(records, policy)[0]!)).toBe("active");
  });

  it("activates on repeated confirmation under autonomous", () => {
    const policy = resolvePromotionPolicy({ mode: "autonomous" });

    expect(
      directiveStatus(
        applyPromotionPolicy([directive("check inputs", { confidence: 0.9 })], policy)[0]!,
      ),
    ).toBe("active");
    expect(
      directiveStatus(
        applyPromotionPolicy([directive("check inputs", { confidence: 0.6 })], policy)[0]!,
      ),
    ).toBe("candidate");
  });

  it("retires an active directive whose confidence collapsed", () => {
    const policy = resolvePromotionPolicy();
    const records = [withStatus(directive("stale rule", { confidence: 0.1 }), "active")];

    expect(directiveStatus(applyPromotionPolicy(records, policy)[0]!)).toBe("retired");
  });

  it("leaves non-directive records untouched", () => {
    const fact = createRecord({ kind: "fact", text: "the user prefers pnpm" }, NOW, "f1");

    expect(applyPromotionPolicy([fact], resolvePromotionPolicy())[0]).toBe(fact);
  });
});

describe("formatDirectives", () => {
  it("renders nothing when no directive is active", () => {
    expect(formatDirectives([directive("not yet approved")])).toBe("");
  });

  it("states that a learned note never overrides authored instructions", () => {
    const records = [
      withStatus(
        directive("Run the migration check before deploying.", { importance: 0.9 }),
        "active",
      ),
      withStatus(directive("Prefer the replica for read queries.", { importance: 0.5 }), "active"),
    ];

    const block = formatDirectives(records);

    expect(block).toContain("## Learned operating notes");
    expect(block).toContain("never as replacements");
    expect(block.indexOf("Run the migration check")).toBeLessThan(
      block.indexOf("Prefer the replica"),
    );
  });

  it("stops at the character budget", () => {
    const records = Array.from({ length: 40 }, (_unused, index) =>
      withStatus(directive(`Rule number ${index} with a reasonably long body.`), "active"),
    );

    expect(formatDirectives(records, { maxCharacters: 700 }).length).toBeLessThanOrEqual(700);
  });

  it("orders active directives by importance", () => {
    const records = [
      withStatus(directive("low", { importance: 0.2 }), "active"),
      withStatus(directive("high", { importance: 0.9 }), "active"),
      directive("candidate"),
    ];

    expect(activeDirectives(records).map((record) => record.text)).toEqual(["high", "low"]);
  });
});
