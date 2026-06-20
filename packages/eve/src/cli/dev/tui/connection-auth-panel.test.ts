import { describe, expect, it } from "vitest";

import {
  renderConnectionAuthPanel,
  type ConnectionAuthPanelState,
} from "./connection-auth-panel.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: true, unicode: true });

describe("renderConnectionAuthPanel", () => {
  it("matches the setup-panel spacing and styles while counting down", () => {
    const state: ConnectionAuthPanelState = {
      cancelFocused: false,
      expiresAt: "2026-06-19T03:26:34.298Z",
      frame: "⠴",
      name: "linear",
      now: Date.parse("2026-06-19T03:24:42.298Z"),
      url: "https://connect.vercel.com/authorize/sca_example",
      userCode: "YZW-OPX",
    };

    const rows = renderConnectionAuthPanel(state, theme, 100);

    expect(rows[0]).toBe(`\x1b[2m${"▔".repeat(100)}\x1b[22m`);
    expect(rows[1]).toBe("   Authorization required for \x1b[1mlinear\x1b[22m");
    expect(rows[3]).toBe(
      "   \x1b[33m⠴\x1b[39m \x1b[2mWaiting for connection authorization… 112s\x1b[22m",
    );
    expect(rows[4]).toBe("     \x1b[2mhttps://connect.vercel.com/authorize/sca_example\x1b[22m");
    expect(rows[6]).toBe("     Code: \x1b[1mYZW-OPX\x1b[22m");
    expect(rows[8]).toBe("   \x1b[2m◦\x1b[22m Cancel");

    const oneSecondLater = renderConnectionAuthPanel(
      { ...state, now: state.now + 1_000 },
      theme,
      100,
    );
    expect(oneSecondLater[3]).toContain("111s");
  });

  it("uses the existing focused option grammar for Cancel", () => {
    const rows = renderConnectionAuthPanel(
      {
        cancelFocused: true,
        frame: "⠴",
        name: "linear",
        now: 0,
      },
      theme,
      80,
    );

    expect(rows.at(-1)).toBe("   \x1b[36m▷\x1b[39m \x1b[36mCancel\x1b[39m");
  });
});
