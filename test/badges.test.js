import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateBadges } from "../src/scorer.js";

// Helper to create a minimal session
function makeSession(overrides = {}) {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    model: overrides.model || "claude-sonnet-4-20250514",
    turns: overrides.turns || [],
    clearPoints: overrides.clearPoints || [],
    startTime: overrides.startTime || new Date().toISOString(),
    totals: {
      userMessages: 5,
      toolCalls: 10,
      totalTokens: 100_000,
      cacheHitRate: 0.5,
      estimatedCost: 1.0,
      ...overrides.totals,
    },
  };
}

// Helper to create scored session (session + score dimensions)
function makeScoredSession(overrides = {}) {
  return {
    ...makeSession(overrides),
    score: overrides.score || 70,
    dimensions: {
      toolRatio: 70,
      cacheHitRate: 50,
      contextManagement: 70,
      modelFit: 70,
      promptSpecificity: 70,
      ...overrides.dimensions,
    },
  };
}

// Helper to create assistant turns with costs for inflection detection
function makeTurns(costs) {
  const turns = [];
  for (const cost of costs) {
    turns.push({ role: "user", promptLength: 100 });
    turns.push({
      role: "assistant",
      cost,
      tokens: { input: 5000, output: 1000 },
    });
  }
  return turns;
}

describe("Negative Badges", () => {
  describe("opus-addict", () => {
    it("triggers when >70% of sessions misuse Opus", () => {
      const scored = Array.from({ length: 10 }, () =>
        makeScoredSession({
          model: "claude-opus-4-20250514",
          dimensions: { modelFit: 40 },
        })
      );
      const badges = evaluateBadges(scored, scored);
      const badge = badges.find((b) => b.id === "opus-addict");
      assert.ok(badge, "opus-addict badge should be awarded");
      assert.equal(badge.negative, true);
    });

    it("does NOT trigger when Opus is used appropriately", () => {
      const scored = Array.from({ length: 10 }, () =>
        makeScoredSession({
          model: "claude-opus-4-20250514",
          dimensions: { modelFit: 90 },
        })
      );
      const badges = evaluateBadges(scored, scored);
      assert.ok(!badges.find((b) => b.id === "opus-addict"));
    });

    it("does NOT trigger with fewer than 5 sessions", () => {
      const scored = Array.from({ length: 3 }, () =>
        makeScoredSession({
          model: "claude-opus-4-20250514",
          dimensions: { modelFit: 40 },
        })
      );
      const badges = evaluateBadges(scored, scored);
      assert.ok(!badges.find((b) => b.id === "opus-addict"));
    });

    it("does NOT trigger when mostly using Sonnet", () => {
      const scored = [
        ...Array.from({ length: 8 }, () =>
          makeScoredSession({ model: "claude-sonnet-4-20250514" })
        ),
        ...Array.from({ length: 2 }, () =>
          makeScoredSession({
            model: "claude-opus-4-20250514",
            dimensions: { modelFit: 40 },
          })
        ),
      ];
      const badges = evaluateBadges(scored, scored);
      assert.ok(!badges.find((b) => b.id === "opus-addict"));
    });
  });

  describe("token-furnace", () => {
    it("triggers when average cost per message is high", () => {
      // $3 cost / 5 messages = $0.60 per message
      const sessions = Array.from({ length: 6 }, () =>
        makeSession({ totals: { userMessages: 5, estimatedCost: 3.0 } })
      );
      const badges = evaluateBadges(sessions, []);
      const badge = badges.find((b) => b.id === "token-furnace");
      assert.ok(badge, "token-furnace badge should be awarded");
      assert.equal(badge.negative, true);
    });

    it("does NOT trigger with low cost per message", () => {
      // $0.50 cost / 5 messages = $0.10 per message
      const sessions = Array.from({ length: 6 }, () =>
        makeSession({ totals: { userMessages: 5, estimatedCost: 0.5 } })
      );
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "token-furnace"));
    });

    it("does NOT trigger with fewer than 5 qualifying sessions", () => {
      const sessions = Array.from({ length: 3 }, () =>
        makeSession({ totals: { userMessages: 5, estimatedCost: 5.0 } })
      );
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "token-furnace"));
    });

    it("excludes sessions with fewer than 3 messages", () => {
      const sessions = [
        // These have < 3 messages, should be excluded
        ...Array.from({ length: 5 }, () =>
          makeSession({ totals: { userMessages: 2, estimatedCost: 10.0 } })
        ),
        // Only 2 qualifying sessions — not enough
        ...Array.from({ length: 2 }, () =>
          makeSession({ totals: { userMessages: 5, estimatedCost: 5.0 } })
        ),
      ];
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "token-furnace"));
    });
  });

  describe("context-hoarder", () => {
    it("triggers when most long sessions have inflection without /clear", () => {
      // Costs that double: baseline ~0.1, then jumps to ~0.5
      const costs = [0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.6, 0.7];
      const sessions = Array.from({ length: 4 }, () =>
        makeSession({
          turns: makeTurns(costs),
          clearPoints: [], // never cleared
        })
      );
      const badges = evaluateBadges(sessions, []);
      const badge = badges.find((b) => b.id === "context-hoarder");
      assert.ok(badge, "context-hoarder badge should be awarded");
      assert.equal(badge.negative, true);
    });

    it("does NOT trigger when /clear is used near inflection", () => {
      const costs = [0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.6, 0.7];
      const sessions = Array.from({ length: 4 }, () =>
        makeSession({
          turns: makeTurns(costs),
          clearPoints: [3], // cleared near inflection
        })
      );
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "context-hoarder"));
    });

    it("does NOT trigger with fewer than 3 long sessions", () => {
      const costs = [0.1, 0.1, 0.1, 0.5, 0.5, 0.5];
      const sessions = Array.from({ length: 2 }, () =>
        makeSession({ turns: makeTurns(costs), clearPoints: [] })
      );
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "context-hoarder"));
    });
  });

  describe("vague-commander", () => {
    it("triggers when >30% of prompts are vague with expensive responses", () => {
      // Build turns where most user prompts are short + expensive responses
      const turns = [];
      for (let i = 0; i < 15; i++) {
        turns.push({ role: "user", promptLength: 10 }); // vague
        turns.push({
          role: "assistant",
          cost: 0.5,
          tokens: { input: 40_000, output: 20_000 }, // > 50k total
        });
      }
      const sessions = [makeSession({ turns })];
      const badges = evaluateBadges(sessions, []);
      const badge = badges.find((b) => b.id === "vague-commander");
      assert.ok(badge, "vague-commander badge should be awarded");
      assert.equal(badge.negative, true);
    });

    it("does NOT trigger when prompts are specific", () => {
      const turns = [];
      for (let i = 0; i < 15; i++) {
        turns.push({ role: "user", promptLength: 200 }); // specific
        turns.push({
          role: "assistant",
          cost: 0.5,
          tokens: { input: 40_000, output: 20_000 },
        });
      }
      const sessions = [makeSession({ turns })];
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "vague-commander"));
    });

    it("does NOT trigger with fewer than 10 total user messages", () => {
      const turns = [];
      for (let i = 0; i < 5; i++) {
        turns.push({ role: "user", promptLength: 10 });
        turns.push({
          role: "assistant",
          cost: 0.5,
          tokens: { input: 40_000, output: 20_000 },
        });
      }
      const sessions = [makeSession({ turns })];
      const badges = evaluateBadges(sessions, []);
      assert.ok(!badges.find((b) => b.id === "vague-commander"));
    });
  });

  describe("negative flag", () => {
    it("positive badges have negative: false", () => {
      // Create sessions that earn surgical-prompter (tool ratio < 2x, 5+ sessions)
      const sessions = Array.from({ length: 6 }, () =>
        makeSession({ totals: { userMessages: 10, toolCalls: 5 } })
      );
      const scored = sessions.map((s) => ({
        ...s,
        score: 90,
        dimensions: { modelFit: 80 },
      }));
      const badges = evaluateBadges(sessions, scored);
      const positive = badges.filter((b) => !b.negative);
      for (const b of positive) {
        assert.equal(b.negative, false, `${b.name} should have negative: false`);
      }
    });
  });
});
