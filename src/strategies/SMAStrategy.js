"use strict";

const logger = require('winston');

class SMAStrategy {
  constructor() {
    this.name = 'SMA';
    this.parameters = {
      short_period: 10,
      long_period: 50,
      stop_loss_pct: 0.02,
      take_profit_pct: 0.04
    };
  }

  async execute(portfolio, symbol, initial_balance, position_size, stop_loss, take_profit) {
    try {
      // Override default parameters with provided values
      const params = { ...this.parameters };
      if (stop_loss) params.stop_loss_pct = stop_loss;
      if (take_profit) params.take_profit_pct = take_profit;

      // Get historical data for backtesting or latest price for live trading
      const prices = await this.getPriceData(symbol);
      
      // Calculate SMAs
      const shortSMA = this.calculateSMA(prices, params.short_period);
      const longSMA = this.calculateSMA(prices, params.long_period);
      
      // Generate signals
      const signals = this.generateSignals(shortSMA, longSMA);
      
      // Execute trades based on signals
      const position = await this.executeTrade(portfolio, symbol, signals, initial_balance, position_size, params);
      
      logger.info(`SMA Strategy executed for ${symbol}: ${position ? 'Position opened' : 'No position taken'}`);
      return position;
    } catch (error) {
      logger.error(`Error in SMA Strategy for ${symbol}:`, error.message);
      throw error;
    }
  }

  async getPriceData(_symbol) {
    // In a real implementation, this would fetch data from the API
    // For demo purposes, we'll generate mock data
    const data = [];
    let basePrice = 1.1000; // EUR/USD example
    
    for (let i = 0; i < 100; i++) {
      const volatility = 0.001;
      const change = (Math.random() - 0.5) * 2 * volatility;
      const price = basePrice * (1 + change);
      data.push({
        timestamp: new Date(Date.now() - (99 - i) * 60000), // 1-minute intervals
        price: price
      });
      basePrice = price;
    }
    
    return data;
  }

  calculateSMA(prices, period) {
    if (!Array.isArray(prices) || !Number.isInteger(period) || period <= 0 || prices.length < period) {
      return null;
    }
    const values = prices.slice(-period).map(d => d.price);
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / period;
  }

  generateSignals(shortSMA, longSMA) {
    if (!Number.isFinite(shortSMA) || !Number.isFinite(longSMA)) {
      return { action: 'HOLD', strength: 0, timestamp: new Date().toISOString() };
    }
    
    if (shortSMA > longSMA) {
      return {
        action: 'BUY',
        strength: Math.min((shortSMA / longSMA - 1) * 100, 10),
        timestamp: new Date().toISOString()
      };
    } else if (shortSMA < longSMA) {
      return {
        action: 'SELL',
        strength: Math.min((1 - shortSMA / longSMA) * 100, 10),
        timestamp: new Date().toISOString()
      };
    }
    
    return {
      action: 'HOLD',
      strength: 0,
      timestamp: new Date().toISOString()
    };
  }

  async executeTrade(_portfolio, symbol, signal, initial_balance, position_size, params) {
    if (signal.action === 'HOLD') {
      return null;
    }

    const side = signal.action;
    const price = await this.getCurrentPrice(symbol);
    const size = position_size || this.calculatePositionSize(initial_balance, price, params);
    
    const position = {
      id: `pos_${Date.now()}_${symbol}`,
      symbol,
      side,
      size,
      entry_price: price,
      stop_loss: price * (1 - (side === 'BUY' ? params.stop_loss_pct : -params.stop_loss_pct)),
      take_profit: price * (1 + (side === 'BUY' ? params.take_profit_pct : -params.take_profit_pct)),
      entry_time: new Date().toISOString(),
      strategy: this.name,
      status: 'OPEN'
    };
    
    return position;
  }

  calculatePositionSize(balance, price, params) {
    // 2% risk per trade
    const riskAmount = balance * 0.02;
    const stopLossDistance = price * params.stop_loss_pct;
    return Math.floor(riskAmount / stopLossDistance);
  }

  async getCurrentPrice(symbol) {
    // Mock current price
    const mockPrices = {
      'EUR/USD': 1.1000,
      'GBP/USD': 1.2800,
      'USD/JPY': 149.50,
      'USD/CHF': 0.9200,
      'AUD/USD': 0.6700,
      'USD/CAD': 1.3500
    };
    
    return mockPrices[symbol] || 1.0000;
  }

  getStrategyInfo() {
    return {
      name: this.name,
      parameters: this.parameters,
      description: 'Simple Moving Average crossover strategy',
      recommended_symbols: ['EUR/USD', 'GBP/USD', 'USD/JPY'],
      timeframe: 'M1'
    };
  }
}

module.exports = SMAStrategy;