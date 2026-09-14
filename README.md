# @gmbl/gm-slots

Exact math for line slots: payline evaluation, closed-form basis over reel frequencies, and a
reel-strip tuner that hits a target RTP and hit rate under count constraints.

TypeScript, zero runtime dependencies, `node --test`.

## What it does

- **`evaluateTuple` / `evaluateLine` / `evaluatePaylines`** — left-to-right line wins with a wild
  that substitutes and pays on its own.
- **`lineRtp` / `hitRate` / basis helpers** — exact figures computed from reel frequencies, not
  from simulation. The brute-force cross-check lives in the tests: every formula is verified
  against a full enumeration of a small slot.
- **`tuneReels`** — composes reel strips for a target RTP, then corrects composition for a target
  hit rate, honouring per-symbol count bounds and special-symbol placement rules.
- **`validate`** — strip invariants (window bounds, gaps between special symbols).

## What it deliberately does not do

No free spins, no bonus rounds, no session state, no RNG-driven gameplay — those belong to the
game engine. A real slot reaches 96% RTP with features on top; this package computes the base
game, which is typically a fraction of that.

The tuner fails loudly. If a target is unreachable under the given constraints, it throws
`TunerError` with the achievable range instead of silently returning the nearest miss — a strip
that quietly misses its target ends up in a production game and stays there for years.

## Fixtures

Test fixtures are synthetic. `SAMPLE` is an invented 5×3 slot; `SMALL` is a 3-reel slot small
enough for exhaustive enumeration, which is what the exact formulas are checked against.
