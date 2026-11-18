# Dip-Reversion Rider v3 — btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/haidildariell/cbbtc-race-bot-3/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/haidildariell/cbbtc-race-bot-3/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Trading bot for the make.fun competition **Race a BTC trading bot live for 24 hours**
(`btc-race-24h-20261118-1444`): trades Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute on-chain bars, starting from $1,000 paper USDC, long only.

## Strategy

One-minute momentum chasing loses on this pool: the dev window is a wide, choppy
grind and every short-horizon trend rule tested lost money to the ~26 bps
round-trip cost (4 bps fee + 2 bps slippage + price impact each way). What works
is the opposite — buy the deep dip, sell the bounce:

- Track a slow **240-bar exponential average** of the close (integer math, no floats).
- **Enter:** flat, the close is more than **130 bps below** the 240-bar average,
  **and** the bar ticked back up from the previous close (uptick confirmation —
  buy the dip after it has stopped falling, not while it is still falling)
  → buy with **100% of cash** (one order, fills at the next bar's open).
- **Exit:** sell the whole position when the close bounces **110 bps above**
  the fill price, or on an **80 bps hard stop** below the fill, or a **100 bps
  trailing stop** off the peak since the fill, or a **300-bar time stop** when
  the trade never bounces.
- **Cooldown:** 30 bars flat after every exit, so a falling knife is never
  re-caught immediately. No entry before bar 60, and no new position in the
  last 30 bars of the window (a trade that late cannot earn back its
  round-trip cost before the final flatten).

The dev window for this race falls 280 bps net with a 335 bps range, so the
plain 55 bps dip rule from the previous race barely trades here (one losing
trade, −$4.73). The deep-dip + uptick version catches the two real plunges
instead: buys at bar 67 and bar 130, both sold into the recovery for a win.

Deterministic by construction: no clock, no randomness, no network, no files
outside the repo — only the bars the harness sends. Two runs on the same window
produce identical action logs (L1 regrade reproduced byte for byte).

## Local grade (dev window, kit `grade-local --driver process`)

| metric | value |
|---|---|
| net PnL | **+$20.32** |
| trades | 4 (2 round trips, win rate 100%) |
| max drawdown | 0.67% |
| fees | $1.62 |

Dev gate (net PnL > $0) **passes with margin**. At 2× fees the same run still
nets **+$18.70**, so the edge is not fee-thin.

## Layout

- `main.ts` — the bot (Node 22, type-stripped TS), speaks `agent-fun/bars-replay/v1`
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's official SDK shim
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
