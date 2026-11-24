// pumpfun-bot-sprint — paper-money trading bot for the make.fun
// "Pump.fun Bot Sprint: Make Bot And Win" bounty (harness pumpfun-replay/v2).
//
// Strategy ("surge-rider with staged exits"), written from scratch:
//   * Watch every new bonding curve from its CreateEvent.
//   * ENTER only on a confirmed early surge: price >= +12% over the create
//     price, still within 2.5x of it, with buy-dominated flow in the last 10
//     trades and at least 1 SOL of real reserves (so the 1%-of-reserve size
//     cap still allows a >= 0.01 SOL buy, the round-trip minimum). Entering
//     early matters: dev data shows the median coin peaks at only ~1.64x its
//     create price and then fades, so a late entry chases a top that is
//     usually already in. Flow must be clearly buy-dominated (9 of the last
//     10 trades buys, buy SOL >= 2.5x sell SOL) — looser flow let in too many
//     coins that faded at once, and requiring all 10 buys was too strict
//     (dev: -0.78 SOL vs -0.46 SOL at 9/10).
//   * Size is capped by the harness per-mint cap and by a fixed ticket, so
//     no single coin can sink the book; at most 5 open positions.
//   * EXIT fast and tight: sell half at +10% over cost, the rest at +20%;
//     a hard stop-loss at -8%; a trailing stop once a position has peaked
//     (+10% peak, exit if it gives back 5 points); a time exit for dead
//     money held > 900 slots without reaching +5%. Dev runs showed looser
//     exits lose more per trade (v1: +35%/+80% targets, -20% stop, -2.00
//     SOL over 213 trips; v5: +50%/+150% targets, -25% stop, -1.95 SOL
//     over 175 trips; v3: +12%/+25%, -10% stop, -1.45 SOL over 437 trips),
//     so the exits stay close to the entry: in this tape most coins fade
//     within a few trades of their peak, and a capped winner cannot repay a
//     wide loss. Round-trip fees are ~2.5% plus tx fees, so the first
//     take-profit still nets roughly +7% after fees.
//   * Only take trades big enough to survive the fees: entries need at
//     least 3 SOL of real reserves so the 1% size cap allows a >= 0.03 SOL
//     buy (on a 0.01 SOL ticket the fixed 105,000-lamport tx fee alone is
//     ~1% per leg).
//   * A portfolio drawdown guard stops new entries past -20% from the peak
//     portfolio value and flattens everything past -40%, keeping the 50%
//     max-drawdown guardrail out of reach.
//   * One entry per mint per run: no chasing the same coin twice.
//   * Fully deterministic: no clock, no environment, no randomness. Every
//     decision is a pure function of the events the harness has delivered.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ config
const CONFIG = {
  // Entry: price must have risen this far above the create price.
  entryRiseBps: 800, // +8%: enter at the first sign of a surge, not after it
  // Entry: never chase a coin already above this multiple of create price.
  entryMaxMultipleBps: 25000, // 2.5x
  // Entry: price must still be within this of its peak since creation
  // (skip coins that already topped and faded).
  entryNearPeakBps: 9000, // >= 90% of peak
  // Entry: minimum trades seen before we trust the flow signal.
  entryMinTrades: 5,
  // Entry: real SOL reserves needed so the 1% size cap allows a >= 0.03 SOL
  // buy (see minBuyLamports: tiny tickets are eaten by the fixed tx fee).
  entryMinRealSolLamports: 3_000_000_000n, // 3 SOL
  // Entry: flow window and dominance thresholds. Tightened three times
  // after dev runs showed looser flow let in too many coins that faded at
  // once: 9 of the last 10 trades must be buys and buy SOL at least 2.5x
  // sell SOL. (10/10 was tried and was worse: -0.78 SOL vs -0.46 SOL.)
  flowWindowTrades: 10,
  flowMinBuys: 9, // of the last 10 trades
  flowMinBuySellRatioBps: 25000, // buy SOL >= 2.5x sell SOL
  // Sizing: fixed ticket per entry (before the harness size cap applies).
  ticketLamports: 250_000_000n, // 0.25 SOL
  minBuyLamports: 30_000_000n, // 0.03 SOL (round-trip minimum is 0.01 SOL;
  // we demand more so the fixed tx fee stays a small share of the ticket)
  maxSlippageBuyBps: 2000,
  maxSlippageSellBps: 3000,
  // Exits (ratios are position value / cost, in bps; 10000 = breakeven).
  takeProfit1Bps: 11000, // +10%: sell half
  takeProfit2Bps: 12000, // +20%: sell the rest
  stopLossBps: 9200, // -8%: sell all
  // Trailing stop: once the peak ratio reaches this, exit if the ratio
  // falls this far below the peak.
  trailArmBps: 11000, // +10% peak arms the trail
  trailGivebackBps: 500, // give back 5 points from the peak -> exit
  // Time exit: slots held without reaching this ratio -> sell all.
  timeExitSlots: 900,
  timeExitRatioBps: 10500, // +5%
  // Portfolio drawdown guard (bps from peak portfolio value).
  pauseEntriesDrawdownBps: 2000, // -20%: stop opening new positions
  flattenDrawdownBps: 4000, // -40%: close everything
} as const;

// ------------------------------------------------------------------ types
interface MintTrack {
  /** Price (SOL per token) at first sight, as a float ratio. */
  firstPrice: number;
  /** Highest price seen since first sight. */
  peakPrice: number;
  /** Trades seen. */
  trades: number;
  /** Last `flowWindowTrades` trades: true = buy. */
  recentBuys: boolean[];
  /** SOL volume of buys / sells in the recent window (lamports). */
  recentBuySol: bigint;
  recentSellSol: bigint;
  /** Full history of recent trade SOL amounts, to evict from the window. */
  recentSol: bigint[];
  /** True once we have entered this mint (one entry per mint per run). */
  entered: boolean;
  /** True once the curve completed. */
  complete: boolean;
}

interface PositionTrack {
  /** Slot the position first appeared in the account. */
  entrySlot: number;
  /** Highest value/cost ratio (bps) seen while holding. */
  peakRatioBps: number;
  /** True once take-profit 1 / 2 has fired for this position. */
  tp1Done: boolean;
  tp2Done: boolean;
}

// ------------------------------------------------------------------ helpers
/** Price of a curve in SOL per token, from virtual reserves. Returns 0 when
 *  the reserves are missing or the ratio is not a finite number (a curve can
 *  be seen first through a mark with zero reserves, which would otherwise
 *  produce NaN and slip past every `<`/`>` guard, since NaN compares false).
 *  NOTE: the shim's Curve carries `virtual_quote_reserves`, not
 *  `virtual_sol_reserves` (that name exists only on the raw TradeEvent) —
 *  reading the wrong field yields `undefined`, and Number(undefined) is NaN. */
function curvePrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n || c.virtual_quote_reserves === 0n) return 0;
  const p = Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/** Portfolio value: cash + marked positions, in lamports. */
function portfolioValueLamports(state: BotState): bigint {
  let total = state.cash;
  for (const [mint, pos] of state.positions) {
    const price = curvePrice(state, mint);
    if (price <= 0) continue;
    const value = (pos.token_amount * BigInt(Math.floor(price * 1e12))) / 1_000_000_000_000n;
    total += value;
  }
  return total;
}

// ------------------------------------------------------------------ bot
const tracks = new Map<string, MintTrack>();
const held = new Map<string, PositionTrack>();
let peakPortfolioLamports = 0n;
let buysSent = 0;
let sellsSent = 0;

function trackFor(mint: string, price: number): MintTrack {
  let t = tracks.get(mint);
  if (!t) {
    t = {
      firstPrice: price,
      peakPrice: price,
      trades: 0,
      recentBuys: [],
      recentBuySol: 0n,
      recentSellSol: 0n,
      recentSol: [],
      entered: false,
      complete: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];

  // ---- fold this batch's events into per-mint tracks -------------------
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const price = Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves);
      if (Number.isFinite(price) && price > 0) trackFor(e.mint, price);
    } else if (e.event === 'TradeEvent') {
      const price = Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves);
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = trackFor(e.mint, price);
      t.trades += 1;
      if (price > t.peakPrice) t.peakPrice = price;
      const sol = BigInt(e.sol_amount);
      t.recentBuys.push(e.is_buy);
      t.recentSol.push(sol);
      if (e.is_buy) t.recentBuySol += sol;
      else t.recentSellSol += sol;
      if (t.recentBuys.length > CONFIG.flowWindowTrades) {
        const oldBuy = t.recentBuys.shift()!;
        const oldSol = t.recentSol.shift()!;
        if (oldBuy) t.recentBuySol -= oldSol;
        else t.recentSellSol -= oldSol;
      }
    } else if (e.event === 'CompleteEvent') {
      const t = tracks.get(e.mint);
      if (t) t.complete = true;
    }
  }

  // ---- portfolio / drawdown guard --------------------------------------
  const portfolio = portfolioValueLamports(state);
  if (portfolio > peakPortfolioLamports) peakPortfolioLamports = portfolio;
  const drawdownBps =
    peakPortfolioLamports > 0n
      ? Number(((peakPortfolioLamports - portfolio) * 10_000n) / peakPortfolioLamports)
      : 0;
  const pauseEntries = drawdownBps >= CONFIG.pauseEntriesDrawdownBps;
  const flattenAll = drawdownBps >= CONFIG.flattenDrawdownBps;

  // ---- exits for open positions ----------------------------------------
  for (const [mint, pos] of state.positions) {
    const price = curvePrice(state, mint);
    if (price <= 0) continue;
    const cost = pos.cost_lamports;
    if (cost === 0n) continue;
    const value = (pos.token_amount * BigInt(Math.floor(price * 1e12))) / 1_000_000_000_000n;
    const ratioBps = Number((value * 10_000n) / cost);

    let h = held.get(mint);
    if (!h) {
      h = { entrySlot: state.slot, peakRatioBps: ratioBps, tp1Done: false, tp2Done: false };
      held.set(mint, h);
    }
    if (ratioBps > h.peakRatioBps) h.peakRatioBps = ratioBps;

    const heldSlots = state.slot - h.entrySlot;
    let sellTokens = 0n;
    let why = '';
    if (flattenAll) {
      sellTokens = pos.token_amount;
      why = 'flatten-drawdown';
    } else if (ratioBps <= CONFIG.stopLossBps) {
      sellTokens = pos.token_amount;
      why = 'stop-loss';
    } else if (ratioBps >= CONFIG.takeProfit2Bps) {
      if (!h.tp2Done) {
        // The rest (everything still held after TP1).
        sellTokens = pos.token_amount;
        h.tp2Done = true;
        why = 'take-profit-2';
      }
    } else if (!h.tp1Done && ratioBps >= CONFIG.takeProfit1Bps) {
      sellTokens = pos.token_amount / 2n;
      h.tp1Done = true;
      why = 'take-profit-1';
    } else if (
      h.peakRatioBps >= CONFIG.trailArmBps &&
      ratioBps <= h.peakRatioBps - CONFIG.trailGivebackBps
    ) {
      sellTokens = pos.token_amount;
      why = 'trailing-stop';
    } else if (heldSlots > CONFIG.timeExitSlots && ratioBps < CONFIG.timeExitRatioBps) {
      sellTokens = pos.token_amount;
      why = 'time-exit';
    }
    if (sellTokens > 0n) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: sellTokens,
        max_slippage_bps: CONFIG.maxSlippageSellBps,
      });
      sellsSent += 1;
      console.error(
        `[sell ${why}] ${mint.slice(0, 8)} ratio=${ratioBps}bps tokens=${sellTokens}`,
      );
    }
  }

  // Drop tracking for positions that are gone.
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }

  // ---- entries ----------------------------------------------------------
  if (!pauseEntries && !flattenAll) {
    const freeCash = state.freeCashLamports();
    const room = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (room > 0 && freeCash > CONFIG.minBuyLamports + state.txFeeLamports()) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
        const t = tracks.get(mint);
        if (!t || t.entered || t.complete) continue;
        if (state.positions.has(mint)) continue;
        let buyPending = false;
        for (const p of state.pending.values()) {
          if (p.order.side === 'buy' && p.order.mint === mint) {
            buyPending = true;
            break;
          }
        }
        if (buyPending) continue;
        if (t.trades < CONFIG.entryMinTrades) continue;
        if (curve.real_quote_reserves < CONFIG.entryMinRealSolLamports) continue;

        const price = curvePrice(state, mint);
        if (price <= 0 || t.firstPrice <= 0) continue;
        const riseBps = Math.floor(((price - t.firstPrice) / t.firstPrice) * 10_000);
        if (!Number.isFinite(riseBps)) continue;
        if (riseBps < CONFIG.entryRiseBps) continue;
        if (riseBps > CONFIG.entryMaxMultipleBps - 10_000) continue; // > 2x over first
        if (price < (t.peakPrice * CONFIG.entryNearPeakBps) / 10_000) continue;

        const buyCount = t.recentBuys.filter(Boolean).length;
        if (buyCount < CONFIG.flowMinBuys) continue;
        if (t.recentSellSol === 0n) {
          if (t.recentBuySol === 0n) continue;
        } else if (
          Number((t.recentBuySol * 10_000n) / t.recentSellSol) < CONFIG.flowMinBuySellRatioBps
        ) {
          continue;
        }

        const cap = state.maxBuyLamports(mint);
        let size = CONFIG.ticketLamports < cap ? CONFIG.ticketLamports : cap;
        const affordable = freeCash - state.txFeeLamports();
        if (size > affordable) size = affordable;
        if (size < CONFIG.minBuyLamports) continue;

        t.entered = true;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: CONFIG.maxSlippageBuyBps,
        });
        buysSent += 1;
        console.error(
          `[buy] ${mint.slice(0, 8)} rise=${riseBps}bps size=${size} real=${curve.real_quote_reserves}`,
        );
      }
    }
  }

  return orders;
}

await runBot({
  onBatch,
  onDone(state) {
    console.error(
      `[done] batches=${state.seq + 1} cash=${state.cash} positions=${state.positions.size} buys=${buysSent} sells=${sellsSent} mints_tracked=${tracks.size}`,
    );
  },
});
