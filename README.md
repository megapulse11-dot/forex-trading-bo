# Forex Trading Bot

A Node.js paper-trading and backtesting service for foreign-exchange strategies.

## Requirements

- Node.js 18 or later
- npm

## Run

```powershell
npm install
npm start
```

The dashboard listens on `http://127.0.0.1:3000` by default. The server binds to loopback only. Set `PORT`, `HOST`, `CLIENT_URL`, or `LOG_LEVEL` to override server settings. Do not expose this service directly to the public internet.

Copy `.env.example` to `.env` and add OANDA **practice** credentials to view a practice account. Credentials stay on the server and are never sent to the browser.

Run the tests with:

```powershell
npm test -- --runInBand
```

## API

- `GET /api/health`
- `GET /api/currencies`
- `GET /api/rates/latest?base=EUR&symbols=USD,GBP`
- `GET /api/rates/historical?base=EUR&symbols=USD&start_date=2025-01-01&end_date=2025-01-31`
- `POST /api/strategies/:name/backtest`
- `POST /api/strategies/:name/paper-trade`
- `GET /api/portfolio`
- `GET /api/portfolio/positions`
- `GET /api/portfolio/performance`
- `GET /api/risk/assessment`
- `POST /api/risk/stop-loss`
- `GET /api/live/status`
- `GET /api/live/account`
- `GET /api/live/positions`
- `GET /api/live/pricing?instruments=EUR_USD`
- `GET /api/live/orders/recent`
- `POST /api/live/orders`
- `GET /api/sim/status`
- `GET /api/sim/quotes`
- `GET /api/sim/account`
- `GET /api/sim/positions`
- `GET /api/sim/orders`
- `POST /api/sim/orders`
- `POST /api/sim/positions/:id/close`
- `POST /api/sim/reset`

Supported strategy names are `SMA`, `BollingerBands`, and `Momentum`. The backtester uses daily historical reference rates from Frankfurter, so `timeframe` does not create intraday data.

## Simulation mode

Without OANDA credentials the desk runs in **simulation** and is fully functional rather than read only. The server quotes seven pairs from a bounded tick stream anchored to ECB reference rates, fills orders locally, marks open positions to market, and executes protective stops and targets. Live prices, account NAV, positions, risk and order history stream to the browser over socket.io.

Simulation orders go through `POST /api/sim/orders` and never leave the process. They enforce the same discipline as the broker path: a 1,000 unit cap, stop and target on the correct side of the fill, the 1% account NAV stop-risk limit, a margin check, and the typed `PLACE SIMULATED ORDER` confirmation. `POST /api/sim/reset` clears positions and restores the starting balance, which defaults to 10,000 USD (`SIM_INITIAL_BALANCE`) and ticks every 1.5 seconds (`SIM_TICK_MS`).

Simulation results are not trading performance: fills ignore slippage and spread widening, and prices are generated rather than executable.

Live endpoints use OANDA account state. `GET /api/live/orders/recent` shows the local order journal; `GET /api/live/status` reports when an uncertain broker response has halted new submissions.

## Safety and data limits

Order execution is disabled by default. The manual ticket can send OANDA market orders only after the server has credentials, `TRADING_ENABLED=true`, a fresh tradeable quote, sufficient margin, a stop and target, and explicit typed confirmation. Orders are capped at 1,000 units and estimated stop-loss risk at 1% of account NAV. The broker order attaches both protective exits.

To test order flow, use an OANDA practice account and set `OANDA_ENVIRONMENT=practice` plus `TRADING_ENABLED=true`. Real-money operation additionally requires `OANDA_ENVIRONMENT=live` and `LIVE_TRADING_ACKNOWLEDGED=I_ACCEPT_REAL_MONEY_RISK`; the UI then requires typing `PLACE LIVE ORDER` for each trade. The live endpoint has not been exercised here because no account credentials were supplied. Start with practice and independently verify broker settings before enabling live execution.

Order request IDs and broker outcomes are written atomically to the ignored local `logs/order-journal.json`. If a broker response is ambiguous, the journal halts further order submissions after restart as well as during the current process. Inspect OANDA activity before manually resolving the uncertain record; this local journal is not a substitute for multi-process storage or automated broker reconciliation.

Paper-strategy prices remain generated demonstration data. Backtests use daily Frankfurter reference rates, not streaming executable prices; neither is a validated trading signal. This is an operator-controlled tool, not financial advice.
