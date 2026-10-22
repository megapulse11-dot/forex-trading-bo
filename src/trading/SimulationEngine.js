"use strict";

// Fallback USD-cross table (units of each currency per 1 USD). Used until the
// first successful reference-rate fetch, and whenever the network is missing,
// so the desk still quotes rather than showing a dead screen.
const FALLBACK_USD_RATES = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.5,
  AUD: 1.52,
  CAD: 1.36,
  CHF: 0.88,
  NZD: 1.66
};

const MAX_ORDER_UNITS = 1000;
const MAX_RISK_FRACTION = 0.01;
const MARGIN_RATE = 0.02; // 1:50 leverage
const SPREAD_FRACTION = 0.00012;
const MAX_DRIFT = 0.02; // simulated ticks stay inside a 2% band of the anchor
const MEAN_REVERSION = 0.05;
const MAX_JOURNAL_ENTRIES = 200;
const CONFIRMATION_PHRASE = 'PLACE SIMULATED ORDER';

class SimulationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * A self-contained execution venue used when no broker account is connected.
 *
 * Quotes are a bounded random walk anchored to real ECB reference rates, so the
 * desk fills and marks to market without broker credentials. Everything here is
 * simulated: no order ever leaves this process. It mirrors the discipline of
 * the OANDA path (1,000 unit cap, 1% NAV stop risk, protective exits, typed
 * confirmation) so the same habits carry over to a funded account.
 */
class SimulationEngine {
  constructor(options = {}) {
    this.rateProvider = options.rateProvider || null;
    this.random = options.random || Math.random;
    this.instruments = options.instruments || [
      'EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'EUR_GBP'
    ];
    this.initialBalance = Number.isFinite(options.initialBalance) && options.initialBalance > 0
      ? options.initialBalance
      : 10000;
    this.accountCurrency = 'USD';
    this.tickIntervalMs = options.tickIntervalMs || 1500;
    this.anchorRefreshMs = options.anchorRefreshMs || 10 * 60 * 1000;

    this.usdRates = { ...FALLBACK_USD_RATES };
    this.anchorSource = 'FALLBACK';
    this.anchors = new Map();
    this.quotes = new Map();
    this.positions = new Map();
    this.journal = [];
    this.realizedPnl = 0;
    this.nextId = 1;
    this.timer = null;
    this.lastAnchorRefresh = 0;
    this.closedListener = null;

    this.seedQuotes();
  }

  /* ---- pricing ---------------------------------------------------------- */

  precisionFor(instrument) {
    return instrument.endsWith('_JPY') ? 3 : 5;
  }

  round(value, instrument) {
    const factor = 10 ** this.precisionFor(instrument);
    return Math.round(value * factor) / factor;
  }

  pairCurrencies(instrument) {
    const [base, quote] = instrument.split('_');
    return { base, quote };
  }

  /** Mid price of BASE_QUOTE derived from the USD-cross table. */
  midFromRates(instrument) {
    const { base, quote } = this.pairCurrencies(instrument);
    const baseRate = this.usdRates[base];
    const quoteRate = this.usdRates[quote];
    if (!Number.isFinite(baseRate) || !Number.isFinite(quoteRate) || baseRate <= 0 || quoteRate <= 0) {
      throw new SimulationError(`No reference rate available for ${instrument}`, 503);
    }
    return quoteRate / baseRate;
  }

  toUsd(amount, currency) {
    if (currency === 'USD') return amount;
    const rate = this.usdRates[currency];
    if (!Number.isFinite(rate) || rate <= 0) return amount;
    return amount / rate;
  }

  buildQuote(instrument, mid, timestamp = Date.now()) {
    const spread = mid * SPREAD_FRACTION;
    const anchor = this.anchors.get(instrument) || mid;
    return {
      instrument,
      status: 'tradeable',
      source: 'SIMULATED',
      time: new Date(timestamp).toISOString(),
      mid,
      bid: this.round(mid - spread / 2, instrument),
      ask: this.round(mid + spread / 2, instrument),
      anchor,
      changePercent: anchor > 0 ? ((mid - anchor) / anchor) * 100 : 0
    };
  }

  seedQuotes() {
    const timestamp = Date.now();
    for (const instrument of this.instruments) {
      const mid = this.midFromRates(instrument);
      this.anchors.set(instrument, mid);
      this.quotes.set(instrument, this.buildQuote(instrument, mid, timestamp));
    }
  }

  async refreshAnchors() {
    this.lastAnchorRefresh = Date.now();
    if (!this.rateProvider) return false;
    try {
      const symbols = Object.keys(FALLBACK_USD_RATES).filter(code => code !== 'USD');
      const result = await this.rateProvider.getLatestRates('USD', symbols.join(','));
      const rates = result && result.rates;
      if (!rates) return false;

      const merged = { USD: 1 };
      for (const [code, value] of Object.entries(rates)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) merged[code] = numeric;
      }
      if (Object.keys(merged).length < 2) return false;

      this.usdRates = merged;
      this.anchorSource = 'ECB_REFERENCE';
      for (const instrument of this.instruments) {
        const previousAnchor = this.anchors.get(instrument);
        const mid = this.midFromRates(instrument);
        const quote = this.quotes.get(instrument);
        if (quote && Number.isFinite(previousAnchor) && previousAnchor > 0) {
          // Carry the session's deviation across to the corrected level rather
          // than snapping, so an open position never sees a spurious jump.
          const deviation = quote.mid / previousAnchor;
          this.anchors.set(instrument, mid);
          this.quotes.set(instrument, this.buildQuote(instrument, mid * deviation, Date.parse(quote.time)));
        } else {
          this.anchors.set(instrument, mid);
          this.quotes.set(instrument, this.buildQuote(instrument, mid));
        }
      }
      return true;
    } catch (_error) {
      // Keep quoting from the last known table; a blip must not blank the desk.
      return false;
    }
  }

  /** Advance every quote along a mean-reverting walk and execute exits. */
  tick() {
    const now = Date.now();
    if (now - this.lastAnchorRefresh > this.anchorRefreshMs) {
      this.lastAnchorRefresh = now;
      Promise.resolve(this.refreshAnchors()).catch(() => undefined);
    }

    for (const instrument of this.instruments) {
      const quote = this.quotes.get(instrument);
      const anchor = this.anchors.get(instrument);
      if (!quote || !Number.isFinite(anchor)) continue;

      const reversion = ((anchor - quote.mid) / anchor) * MEAN_REVERSION;
      const shock = (this.random() * 2 - 1) * 0.00035;
      const bounded = Math.min(
        anchor * (1 + MAX_DRIFT),
        Math.max(anchor * (1 - MAX_DRIFT), quote.mid * (1 + reversion + shock))
      );
      this.quotes.set(instrument, this.buildQuote(instrument, bounded, now));
    }

    const closed = this.evaluateExits(now);
    this.markToMarket();
    return closed;
  }

  getQuote(instrument) {
    const quote = this.quotes.get(instrument);
    if (!quote) throw new SimulationError(`Unknown instrument ${instrument}`, 404);
    return { ...quote };
  }

  getQuotes() {
    return Object.fromEntries(Array.from(this.quotes, ([instrument, quote]) => [instrument, { ...quote }]));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  onExit(listener) {
    this.closedListener = listener;
  }

  /* ---- account ---------------------------------------------------------- */

  getAccount() {
    let unrealizedPnl = 0;
    let marginUsed = 0;
    for (const position of this.positions.values()) {
      unrealizedPnl += position.unrealizedPL;
      marginUsed += position.marginUsd;
    }
    const balance = this.initialBalance + this.realizedPnl;
    const nav = balance + unrealizedPnl;

    return {
      id: 'SIMULATION',
      alias: 'Simulated account',
      currency: this.accountCurrency,
      balance,
      NAV: nav,
      unrealizedPL: unrealizedPnl,
      marginUsed,
      marginAvailable: nav - marginUsed,
      openTradeCount: this.positions.size,
      pendingOrderCount: 0,
      initialBalance: this.initialBalance,
      realizedPnl: this.realizedPnl,
      returnPercent: ((nav - this.initialBalance) / this.initialBalance) * 100
    };
  }

  getPositions() {
    return Array.from(this.positions.values(), position => ({ ...position }));
  }

  getJournal(limit = 50) {
    return this.journal.slice(0, limit).map(entry => ({ ...entry }));
  }

  /* ---- positions -------------------------------------------------------- */

  markToMarket() {
    for (const position of this.positions.values()) {
      const quote = this.quotes.get(position.instrument);
      if (!quote) continue;
      position.current_price = position.side === 'BUY' ? quote.bid : quote.ask;
      const direction = position.side === 'BUY' ? 1 : -1;
      const pnlQuote = direction * (position.current_price - position.entry_price) * position.units;
      position.unrealizedPL = this.toUsd(pnlQuote, position.quoteCurrency);
      position.updatedAt = new Date().toISOString();
    }
  }

  evaluateExits(now = Date.now()) {
    const closed = [];
    for (const position of Array.from(this.positions.values())) {
      const quote = this.quotes.get(position.instrument);
      if (!quote) continue;

      let exitPrice = null;
      let reason = null;
      if (position.side === 'BUY') {
        if (quote.ask <= position.stop_loss) {
          exitPrice = position.stop_loss;
          reason = 'STOP';
        } else if (quote.ask >= position.take_profit) {
          exitPrice = position.take_profit;
          reason = 'TARGET';
        }
      } else if (quote.bid >= position.stop_loss) {
        exitPrice = position.stop_loss;
        reason = 'STOP';
      } else if (quote.bid <= position.take_profit) {
        exitPrice = position.take_profit;
        reason = 'TARGET';
      }

      if (exitPrice !== null) closed.push(this.closePosition(position.id, exitPrice, reason, now));
    }
    return closed;
  }

  openRiskUsd() {
    let total = 0;
    for (const position of this.positions.values()) total += position.riskUsd;
    return total;
  }

  validateOrder(input) {
    const request = input && typeof input === 'object' ? input : {};
    const instrument = String(request.instrument || '').toUpperCase();
    if (!this.instruments.includes(instrument)) {
      throw new SimulationError('Choose a supported instrument', 422);
    }
    const side = String(request.side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) {
      throw new SimulationError('Side must be BUY or SELL', 422);
    }

    const units = Number(request.units);
    if (!Number.isInteger(units) || units < 1) {
      throw new SimulationError('Units must be a whole number of at least 1', 422);
    }
    if (units > MAX_ORDER_UNITS) {
      throw new SimulationError(`Orders are capped at ${MAX_ORDER_UNITS.toLocaleString()} units`, 422);
    }

    const stopLoss = Number(request.stopLoss);
    const takeProfit = Number(request.takeProfit);
    if (!Number.isFinite(stopLoss) || stopLoss <= 0 || !Number.isFinite(takeProfit) || takeProfit <= 0) {
      throw new SimulationError('A stop loss and a take-profit price are both required', 422);
    }

    if (request.confirmation !== CONFIRMATION_PHRASE) {
      throw new SimulationError(`Type ${CONFIRMATION_PHRASE} to confirm this simulated order`, 400);
    }

    return { instrument, side, units, stopLoss, takeProfit };
  }

  placeOrder(input) {
    const request = this.validateOrder(input);
    const clientRequestId = String(input.clientRequestId || `sim-${Date.now()}-${this.nextId}`);
    const duplicate = this.journal.find(entry => (
      entry.clientRequestId === clientRequestId && entry.type === 'OPEN' && entry.status === 'FILLED'
    ));
    if (duplicate) return { ...duplicate, duplicate: true };

    const quote = this.getQuote(request.instrument);
    if (quote.status !== 'tradeable') {
      throw new SimulationError('The simulated market is not tradeable right now', 503);
    }

    const { quote: quoteCurrency } = this.pairCurrencies(request.instrument);
    const entryPrice = request.side === 'BUY' ? quote.ask : quote.bid;

    if (request.side === 'BUY' && request.stopLoss >= entryPrice) {
      throw new SimulationError('Stop loss must sit below the buy entry price', 422);
    }
    if (request.side === 'BUY' && request.takeProfit <= entryPrice) {
      throw new SimulationError('Take profit must sit above the buy entry price', 422);
    }
    if (request.side === 'SELL' && request.stopLoss <= entryPrice) {
      throw new SimulationError('Stop loss must sit above the sell entry price', 422);
    }
    if (request.side === 'SELL' && request.takeProfit >= entryPrice) {
      throw new SimulationError('Take profit must sit below the sell entry price', 422);
    }

    const account = this.getAccount();
    const riskQuote = Math.abs(entryPrice - request.stopLoss) * request.units;
    const riskUsd = this.toUsd(riskQuote, quoteCurrency);
    if ((riskUsd + this.openRiskUsd()) / account.NAV > MAX_RISK_FRACTION) {
      throw new SimulationError('Combined open-trade and proposed stop-loss risk exceeds the 1% account NAV limit', 422);
    }

    const notionalUsd = this.toUsd(entryPrice * request.units, quoteCurrency);
    const marginUsd = notionalUsd * MARGIN_RATE;
    if (marginUsd + account.marginUsed > account.marginAvailable) {
      throw new SimulationError('Not enough free margin for this position size', 422);
    }

    const now = Date.now();
    const positionId = `sim-${this.nextId++}`;
    const position = {
      id: positionId,
      clientRequestId,
      instrument: request.instrument,
      symbol: request.instrument.replace('_', '/'),
      quoteCurrency,
      side: request.side,
      units: request.units,
      entry_price: entryPrice,
      current_price: entryPrice,
      stop_loss: request.stopLoss,
      take_profit: request.takeProfit,
      unrealizedPL: 0,
      riskUsd,
      marginUsd,
      opened_at: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      status: 'OPEN'
    };

    this.positions.set(positionId, position);
    const reference = `SIM-${String(this.nextId - 1).padStart(4, '0')}`;
    const record = {
      clientRequestId,
      type: 'OPEN',
      instrument: request.instrument,
      side: request.side,
      units: request.units,
      status: 'FILLED',
      reference,
      positionId,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      price: entryPrice,
      updatedAt: now
    };
    this.journal.unshift(record);
    this.trimJournal();

    return {
      ...record,
      openedAt: position.opened_at,
      estimatedRisk: riskUsd,
      marginReserved: marginUsd,
      currency: this.accountCurrency,
      simulated: true
    };
  }

  closePosition(positionId, exitPrice, reason = 'MANUAL', now = Date.now()) {
    const position = this.positions.get(positionId);
    if (!position) throw new SimulationError('Position not found', 404);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
      throw new SimulationError('Exit price must be a positive number', 422);
    }

    const direction = position.side === 'BUY' ? 1 : -1;
    const pnlQuote = direction * (exitPrice - position.entry_price) * position.units;
    const pnlUsd = this.toUsd(pnlQuote, position.quoteCurrency);
    this.realizedPnl += pnlUsd;
    this.positions.delete(positionId);

    const closingSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const record = {
      clientRequestId: position.clientRequestId,
      type: 'CLOSE',
      instrument: position.instrument,
      side: closingSide,
      units: position.units,
      status: 'CLOSED',
      reference: reason,
      positionId,
      price: exitPrice,
      realizedPnl: pnlUsd,
      updatedAt: now
    };
    this.journal.unshift(record);
    this.trimJournal();

    const result = {
      ...record,
      entryPrice: position.entry_price,
      exitPrice,
      reason,
      closedAt: new Date(now).toISOString(),
      simulated: true
    };
    if (this.closedListener) this.closedListener(result);
    return result;
  }

  closePositionById(positionId) {
    const position = this.positions.get(positionId);
    if (!position) throw new SimulationError('Position not found', 404);
    const quote = this.getQuote(position.instrument);
    const exitPrice = position.side === 'BUY' ? quote.bid : quote.ask;
    return this.closePosition(positionId, exitPrice, 'MANUAL');
  }

  reset() {
    this.positions.clear();
    this.journal = [];
    this.realizedPnl = 0;
    this.nextId = 1;
    this.seedQuotes();
    return this.getAccount();
  }

  trimJournal() {
    if (this.journal.length > MAX_JOURNAL_ENTRIES) this.journal.length = MAX_JOURNAL_ENTRIES;
  }
}

module.exports = {
  SimulationEngine,
  SimulationError,
  CONFIRMATION_PHRASE,
  MAX_ORDER_UNITS
};

