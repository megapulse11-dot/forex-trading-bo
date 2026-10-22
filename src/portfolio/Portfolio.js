"use strict";

class Portfolio {
  constructor(initialBalance = 100000) {
    if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
      throw new Error('Initial balance must be a positive number');
    }

    this.initialBalance = initialBalance;
    this.realizedPnl = 0;
    this.positions = new Map();
    this.closedTrades = [];
    this.performance = [];
    this.recordPerformance();
  }

  addPosition(position) {
    if (!position || !position.id || !position.symbol || !['BUY', 'SELL'].includes(position.side)) {
      throw new Error('Position requires an id, symbol, and valid side');
    }
    if (!Number.isFinite(position.size) || position.size <= 0 ||
        !Number.isFinite(position.entry_price) || position.entry_price <= 0) {
      throw new Error('Position requires a positive size and entry price');
    }
    if (this.positions.has(position.id)) {
      throw new Error(`Position ${position.id} already exists`);
    }

    const stored = { ...position, current_price: position.entry_price };
    this.positions.set(position.id, stored);
    this.recordPerformance();
    return { ...stored };
  }

  updatePositionPrice(positionId, currentPrice) {
    const position = this.positions.get(positionId);
    if (!position) throw new Error(`Position ${positionId} not found`);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      throw new Error('Current price must be a positive number');
    }

    position.current_price = currentPrice;
    this.recordPerformance();
    return { ...position };
  }

  closePosition(positionId, exitPrice) {
    const position = this.positions.get(positionId);
    if (!position) throw new Error(`Position ${positionId} not found`);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
      throw new Error('Exit price must be a positive number');
    }

    const direction = position.side === 'BUY' ? 1 : -1;
    const pnl = direction * (exitPrice - position.entry_price) * position.size;
    const trade = {
      ...position,
      exit_price: exitPrice,
      exit_time: new Date().toISOString(),
      realized_pnl: pnl,
      status: 'CLOSED'
    };

    this.positions.delete(positionId);
    this.realizedPnl += pnl;
    this.closedTrades.push(trade);
    this.recordPerformance();
    return { ...trade };
  }

  getPositions() {
    return Array.from(this.positions.values(), position => ({ ...position }));
  }

  getSummary() {
    const unrealizedPnl = this.getPositions().reduce((total, position) => {
      const direction = position.side === 'BUY' ? 1 : -1;
      return total + direction * (position.current_price - position.entry_price) * position.size;
    }, 0);
    const balance = this.initialBalance + this.realizedPnl;
    const equity = balance + unrealizedPnl;

    return {
      initial_balance: this.initialBalance,
      balance,
      equity,
      realized_pnl: this.realizedPnl,
      unrealized_pnl: unrealizedPnl,
      total_pnl: this.realizedPnl + unrealizedPnl,
      return_percent: ((equity - this.initialBalance) / this.initialBalance) * 100,
      open_positions: this.positions.size,
      closed_trades: this.closedTrades.length
    };
  }

  getPerformanceData() {
    return this.performance.map(point => ({ ...point }));
  }

  recordPerformance() {
    const summary = this.getSummary ? this.getSummary() : { equity: this.initialBalance };
    this.performance.push({ timestamp: new Date().toISOString(), equity: summary.equity });
  }
}

module.exports = Portfolio;