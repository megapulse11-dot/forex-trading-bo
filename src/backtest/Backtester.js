"use strict";

const FrankfurterAPI = require('../api/FrankfurterAPI');

class Backtester {
  constructor(rateProvider = new FrankfurterAPI()) {
    this.rateProvider = rateProvider;
  }

  async runBacktest(strategy, symbol, startDate, endDate, timeframe, initialBalance = 100000) {
    if (!strategy || !strategy.name) throw new Error('A valid strategy is required');
    if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
      throw new Error('Initial balance must be a positive number');
    }
    const pair = /^([A-Z]{3})\/([A-Z]{3})$/.exec(String(symbol || '').toUpperCase());
    if (!pair) throw new Error('Symbol must use the BASE/QUOTE format, such as EUR/USD');
    if (!startDate || !endDate || new Date(startDate) > new Date(endDate)) {
      throw new Error('A valid start and end date are required');
    }

    const [, base, quote] = pair;
    const history = await this.rateProvider.getHistoricalRates(base, quote, startDate, endDate);
    const bars = Object.entries(history.rates || {})
      .filter(([, rates]) => Number.isFinite(rates[quote]) && rates[quote] > 0)
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([date, rates]) => ({ date, price: rates[quote] }));

    if (bars.length < 2) throw new Error('Not enough historical prices for this date range');

    let balance = initialBalance;
    let position = null;
    let peakEquity = initialBalance;
    let maxDrawdown = 0;
    const trades = [];
    const equityCurve = [];

    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      let closedAtStopOrTarget = false;

      if (position) {
        const hitStop = position.side === 'BUY'
          ? bar.price <= position.stop_loss
          : bar.price >= position.stop_loss;
        const hitTarget = position.side === 'BUY'
          ? bar.price >= position.take_profit
          : bar.price <= position.take_profit;

        if (hitStop || hitTarget) {
          const exitPrice = hitStop ? position.stop_loss : position.take_profit;
          balance = this.closeTrade(position, exitPrice, bar.date, balance, trades);
          position = null;
          closedAtStopOrTarget = true;
        }
      }

      const signal = this.getSignal(strategy, bars.slice(0, index + 1));
      if (!closedAtStopOrTarget && signal && signal.action !== 'HOLD') {
        if (position && position.side !== signal.action) {
          balance = this.closeTrade(position, bar.price, bar.date, balance, trades);
          position = null;
        }
        if (!position) position = this.openPosition(strategy, signal.action, bar.price, balance, bar.date);
      }

      const unrealized = position
        ? (bar.price - position.entry_price) * position.size * (position.side === 'BUY' ? 1 : -1)
        : 0;
      const equity = balance + unrealized;
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
      equityCurve.push({ date: bar.date, equity });
    }

    if (position) {
      balance = this.closeTrade(position, bars[bars.length - 1].price, bars[bars.length - 1].date, balance, trades);
      equityCurve[equityCurve.length - 1].equity = balance;
    }

    const winningTrades = trades.filter(trade => trade.pnl > 0).length;
    return {
      symbol: `${base}/${quote}`,
      timeframe: timeframe || '1d',
      period: { start_date: startDate, end_date: endDate },
      initial_balance: initialBalance,
      final_balance: balance,
      total_return_percent: ((balance - initialBalance) / initialBalance) * 100,
      total_trades: trades.length,
      winning_trades: winningTrades,
      losing_trades: trades.length - winningTrades,
      win_rate_percent: trades.length ? (winningTrades / trades.length) * 100 : 0,
      max_drawdown_percent: maxDrawdown * 100,
      trades,
      equity_curve: equityCurve
    };
  }

  getSignal(strategy, history) {
    const parameters = strategy.parameters || {};
    if (strategy.name === 'SMA') {
      const shortAverage = strategy.calculateSMA(history, parameters.short_period);
      const longAverage = strategy.calculateSMA(history, parameters.long_period);
      return strategy.generateSignals(shortAverage, longAverage);
    }
    if (strategy.name === 'BollingerBands') {
      const bands = strategy.calculateBollingerBands(history, parameters.period, parameters.standard_dev);
      return strategy.generateSignals(history, bands.upper, bands.middle, bands.lower, bands.percentB, bands.bandwidth, parameters);
    }
    if (strategy.name === 'Momentum') {
      const momentum = strategy.calculateMomentum(history, parameters.momentum_period);
      const rsi = strategy.calculateRSI(history, parameters.rsi_period);
      return strategy.generateSignals(momentum, rsi, parameters);
    }
    throw new Error(`Backtesting is not supported for strategy ${strategy.name}`);
  }

  openPosition(strategy, side, price, balance, date) {
    const parameters = strategy.parameters || {};
    const stopLossPercent = parameters.stop_loss_pct || 0.02;
    const takeProfitPercent = parameters.take_profit_pct || 0.04;
    const stopDistance = price * stopLossPercent;
    const size = (balance * 0.02) / stopDistance;

    return {
      side,
      size,
      entry_price: price,
      entry_date: date,
      stop_loss: price * (1 + (side === 'BUY' ? -stopLossPercent : stopLossPercent)),
      take_profit: price * (1 + (side === 'BUY' ? takeProfitPercent : -takeProfitPercent))
    };
  }

  closeTrade(position, exitPrice, date, balance, trades) {
    const pnl = (exitPrice - position.entry_price) * position.size * (position.side === 'BUY' ? 1 : -1);
    trades.push({ ...position, exit_price: exitPrice, exit_date: date, pnl });
    return balance + pnl;
  }
}

module.exports = Backtester;