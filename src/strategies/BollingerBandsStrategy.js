"use strict";

const logger = require('winston');

class BollingerBandsStrategy {
  constructor() {
    this.name = 'BollingerBands';
    this.parameters = {
      period: 20,
      standard_dev: 2.0,
      stop_loss_pct: 0.02,
      take_profit_pct: 0.04,
      volatility_threshold: 0.5
    };
  }

  async execute(portfolio, symbol, initial_balance, position_size, stop_loss, take_profit) {
    try {
      // Override default parameters with provided values
      const params = { ...this.parameters };
      if (stop_loss) params.stop_loss_pct = stop_loss;
      if (take_profit) params.take_profit_pct = take_profit;

      // Get price data
      const prices = await this.getPriceData(symbol);
      
      // Calculate Bollinger Bands
      const { upper, middle, lower, bandwidth, percentB } = this.calculateBollingerBands(prices, params.period, params.standard_dev);
      
      // Generate signals based on price action and volatility
      const signals = this.generateSignals(prices, upper, middle, lower, percentB, bandwidth, params);
      
      // Execute trades based on signals
      const position = await this.executeTrade(portfolio, symbol, signals, initial_balance, position_size, params);
      
      logger.info(`Bollinger Bands Strategy executed for ${symbol}: ${position ? 'Position opened' : 'No position taken'}`);
      return position;
    } catch (error) {
      logger.error(`Error in Bollinger Bands Strategy for ${symbol}:`, error.message);
      throw error;
    }
  }

  async getPriceData(_symbol) {
    // In a real implementation, this would fetch data from the API
    // For demo purposes, we'll generate mock data
    const data = [];
    let basePrice = 1.1000; // EUR/USD example
    
    for (let i = 0; i < 100; i++) {
      const volatility = 0.002;
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

  calculateBollingerBands(prices, period, standard_dev) {
    const values = prices.map(d => d.price);
    const upper = Array(values.length).fill(null);
    const middle = Array(values.length).fill(null);
    const lower = Array(values.length).fill(null);

    if (!Number.isInteger(period) || period <= 0 || !Number.isFinite(standard_dev) || standard_dev < 0) {
      return { upper, middle, lower, bandwidth: upper.slice(), percentB: upper.slice() };
    }

    for (let i = period - 1; i < values.length; i += 1) {
      const window = values.slice(i - period + 1, i + 1);
      const average = window.reduce((sum, value) => sum + value, 0) / period;
      const deviation = this.calculateStdDev(window, average);
      middle[i] = average;
      upper[i] = average + deviation * standard_dev;
      lower[i] = average - deviation * standard_dev;
    }

    const bandwidth = upper.map((value, index) => (
      Number.isFinite(value) && middle[index] !== 0
        ? ((value - lower[index]) / middle[index]) * 100
        : null
    ));
    const percentB = values.map((price, index) => (
      Number.isFinite(upper[index]) && upper[index] !== lower[index]
        ? (price - lower[index]) / (upper[index] - lower[index])
        : null
    ));

    return { upper, middle, lower, bandwidth, percentB };
  }

  calculateSMA(values, period) {
    const smas = [];
    for (let i = period - 1; i < values.length; i++) {
      const slice = values.slice(i - period + 1, i + 1);
      const sum = slice.reduce((a, b) => a + b, 0);
      smas.push(sum / period);
    }
    return smas;
  }

  calculateStdDev(values, mean) {
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  generateSignals(prices, upper, _middle, lower, percentB, bandwidth, params) {
    const currentPrice = prices[prices.length - 1].price;
    const currentUpper = upper[upper.length - 1];
    const currentLower = lower[lower.length - 1];
    const currentPercentB = percentB[percentB.length - 1];
    const currentBandwidth = bandwidth[bandwidth.length - 1];

    if (![currentPrice, currentUpper, currentLower, currentPercentB, currentBandwidth].every(Number.isFinite)) {
      return { action: 'HOLD', strength: 0, timestamp: new Date().toISOString() };
    }

    if (currentPercentB < 0.2 && currentPrice < currentLower) {
      return {
        action: 'BUY',
        strength: Math.max(0, (0.2 - currentPercentB) * 50),
        timestamp: new Date().toISOString()
      };
    } else if (currentPercentB > 0.8 && currentPrice > currentUpper) {
      return {
        action: 'SELL',
        strength: Math.max(0, (currentPercentB - 0.8) * 50),
        timestamp: new Date().toISOString()
      };
    } else if (currentBandwidth > params.volatility_threshold) {
      return {
        action: 'HOLD',
        strength: 0,
        reason: 'High volatility detected',
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
      description: 'Bollinger Bands strategy for volatility-based entries/exits',
      recommended_symbols: ['EUR/USD', 'GBP/USD', 'USD/JPY'],
      timeframe: 'M1'
    };
  }
}

module.exports = BollingerBandsStrategy;