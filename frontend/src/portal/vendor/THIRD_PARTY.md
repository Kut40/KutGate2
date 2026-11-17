# Third-party works (portal login screens)

Each entry names its own license. Unmodified originals, where kept, are stored as `source.*` in the entry's folder (reference only, not imported).

## Dail (lock screen clock)

- Original: CodePen "Dail"
- Author: Vineeth.TR
- License: MIT
- Files: `../../core/lock/DialClock.tsx`, `../../core/lock/dial-clock.css`
- Changes:
  - Rewritten as a React component; all selectors use the `kg-dial-` prefix.
  - Colors are not fixed black and white; they come from the lock screen tokens (`--kg-lock-*`, falling back to the core tokens), so the clock is readable on the opaque background in light and dark themes.
  - Size is set by one variable (`--kg-dial-size`) and every measure is proportional to it; the clock is hidden when the viewport is 640px high or less.
  - Hours and minutes are always two digits.
  - `prefers-reduced-motion`: the rings do not rotate, only the digits change.

## Team section #grid #scss

- Author: Kristen
- Original: https://codepen.io/kristen17/pen/QWParNm
- License: MIT (full text: `team-section/LICENSE.txt`)
- Files: `team-section/team-section.css`, markup in `../TeamPage.tsx`
- Changes:
  - SCSS compiled to plain CSS; all selectors scoped under `.kg-team`; the pen's `body` rules moved to `.kg-team`.
  - Layout: cards are smaller (3:4 crop) in a 3-column grid (2 columns under 30rem); from 60rem up the intro sits on the left (sticky) and the cards on the right; rows grow downwards as members are added; the original middle-card offset now applies to every row's middle column.
  - Cards show a projects area (first 3 projects as chips, the rest as "+N"); member data lives in `../teamMembers.ts`. Corner accent gradient and icon hover colour use the product accent palette (#00a5ec, #00d7e8) instead of the pen's pink/peach.
  - The intro column is sticky only on screens at least 48rem tall.
  - External assets made local (site CSP allows only `'self'`): Poppins woff2 files (SIL OFL 1.1, Google Fonts) in `team-section/fonts/`, Font Awesome Free 6.5.2 `x-twitter` and `linkedin-in` icons (CC BY 4.0) inlined as SVG with their attribution comment.
