# pumpfun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arwin0204/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arwin0204/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-money trading bot for pump.fun bonding curves, built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty ($2 in USDC). It trades only paper money on a replay of pump.fun chain data — no real wallet, no live trading, no real funds. Strategy: "surge-rider with staged exits" — it enters a new coin only on a confirmed early surge (price +8% over its create price, still under 2.5x, buy-dominated flow in the last 10 trades, at least 3 SOL of real reserves so the ticket stays big enough to survive the fixed tx fee), sizes each ticket at most 0.25 SOL under the harness's 1%-of-real-reserve cap, and exits fast and tight (sell half at +10%, the rest at +20%) with a -8% stop-loss, a trailing stop once a position peaks, a time exit for dead money, and a portfolio drawdown guard that pauses entries past -20% and flattens everything past -40%. Fully deterministic: no clock, no environment reads, no randomness.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=bosowa123&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
