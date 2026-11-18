// Mean-reversion dip buyer for cbBTC/USDC, 1-minute bars (agent-fun/bars-replay/v1).
//
// Rationale: on this Orca pool BTC spends the day chopping inside a wide
// range, and one-minute trend-following hands its edge back to the ~26 bps
// round-trip cost (4 bps fee + 2 bps slippage + price impact, each way).
// Buying weakness and selling strength does the opposite — it gets paid by
// the chop instead of paying for it. The bot therefore has exactly one
// trade shape, repeated patiently:
//
//   * Flat: wait until the close prints clearly below its own 240-bar
//     exponential average — a deep sag, not a wiggle — and the bar has
//     ticked back up from the previous close, so we buy the dip after it
//     has stopped falling, not while it is still falling. Then buy with
//     the whole cash balance.
//   * Long: sell everything the moment the close has bounced a set
//     distance above the fill, or when a hard stop, a trailing stop, or a
//     time stop says the dip is still dipping.
//
// After any exit the bot sits out a cooldown so it cannot immediately
// re-catch the same falling knife, and it never opens a new position in
// the last 30 bars of the window: a trade that late cannot plausibly earn
// back its round-trip cost before the final flatten.
//
// Everything is bigint integer math at the symbol's price_scale; there is
// no clock, no randomness, no network and no file access, so two runs on
// the same window emit byte-identical action logs.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Length of the slow average (bars). 240 bars is slow enough that a
// one-hour plunge reads as a real sag below it, not noise.
const EMA_LEN = 240n;
// Entry: close must sit this far (bps) below the slow average.
const DIP_BPS = 130n;
// Exit on a bounce: close this far (bps) above the fill price.
const TARGET_BPS = 110n;
// Hard stop (bps below fill) and trailing stop (bps given back from the
// best close since the fill).
const STOP_BPS = 80n;
const TRAIL_BPS = 100n;
// Share of available cash committed to each dip buy (bps). Full size: the
// edge is a handful of deep dips, so each one is worth the whole balance,
// and the stops cap the damage when the dip keeps dipping.
const SIZE_BPS = 10000n;
// Bars to stay flat after an exit before the next buy is allowed.
const COOLDOWN_BARS = 30;
// A position that never bounces is closed after this many bars, flat.
const TIME_STOP_BARS = 300;
// Bars of closes needed before the average is trusted for entries.
const MIN_HISTORY_BARS = 60;
// No new position once fewer than 30 bars remain in the 1,440-bar window:
// a trade that late cannot plausibly earn back its round-trip cost before
// the final flatten.
const NO_BUY_AFTER_BAR = 1410;
// Slippage allowance per order, measured from the latest close (bps).
// Open-to-close gaps here are a few bps and our own impact at full size
// is ~7 bps, so 300 bps is effectively wide open and only guards against
// a wild gap between bars.
const MAX_SLIPPAGE_BPS = 300;

// Slow average of the close, as a bigint price. Seeded on the first bar;
// EMA factor 2/(EMA_LEN+1), updated as
// (2 * close + (EMA_LEN - 1) * ema) / (EMA_LEN + 1).
let ema: bigint | null = null;
// Previous bar's close, for the uptick confirmation on entry: buy only
// once the bar has ticked back up from the last close, so we buy the dip
// after it has stopped falling.
let prevClose: bigint | null = null;
// Fill price of the live position, best close since that fill, and the
// batch seq the fill was reported on. All three reset when the position
// is sold.
let entryPrice: bigint | null = null;
let bestSinceEntry: bigint | null = null;
let entrySeq: number | null = null;
// Earliest batch seq on which a fresh buy may be sent.
let earliestBuySeq = 0;

/** (a - b) / b, in basis points, truncated toward zero, exact in integers. */
function bpsBetween(a: bigint, b: bigint): bigint {
  return ((a - b) * 10000n) / b;
}

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];

    // Fold the new close into the average before deciding on this bar.
    ema = ema === null ? close : (2n * close + (EMA_LEN - 1n) * ema) / (EMA_LEN + 1n);

    // Did this bar tick back up from the previous close? Snapshot it now:
    // prevClose is overwritten below, so the flat branch reads the flag.
    const tickedUp = prevClose === null || close > prevClose;
    prevClose = close;

    // Trust the fills the harness reports, never our own guess at them:
    // a buy decided on the previous batch fills at this bar's open and
    // its price arrives here; a sell fill clears the position and starts
    // the cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        bestSinceEntry = entryPrice;
        entrySeq = batch.seq;
      } else {
        entryPrice = null;
        bestSinceEntry = null;
        entrySeq = null;
        earliestBuySeq = batch.seq + COOLDOWN_BARS;
      }
    }

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held === undefined || held.qty === 0n) {
      // Flat: buy the dip once the average has enough history behind it,
      // the cooldown from the last exit has run out, and the window still
      // has room for the trade to pay for itself.
      if (batch.seq < MIN_HISTORY_BARS) return [];
      if (batch.seq < earliestBuySeq) return [];
      if (batch.seq >= NO_BUY_AFTER_BAR) return [];
      if (ema === null) return [];
      const sag = bpsBetween(ema, close);
      if (sag <= DIP_BPS) return [];
      // Uptick confirmation: the dip must have stopped falling on this
      // bar — the close ticks up from the previous close.
      if (!tickedUp) return [];
      const spend = (state.cash * SIZE_BPS) / 10000n;
      if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      orders.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: spend,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      return orders;
    }

    // Long: guard the position. The trailing stop only tightens while the
    // bounce extends, because the peak tracks closes.
    if (entryPrice === null || bestSinceEntry === null) return [];
    if (close > bestSinceEntry) bestSinceEntry = close;
    const rise = bpsBetween(close, entryPrice);
    const pullback = bpsBetween(bestSinceEntry, close);
    const bounced = rise >= TARGET_BPS;
    const stopped = rise <= -STOP_BPS;
    const trailed = pullback >= TRAIL_BPS;
    const stale = entrySeq !== null && batch.seq - entrySeq >= TIME_STOP_BARS;
    if (!bounced && !stopped && !trailed && !stale) return [];
    orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
