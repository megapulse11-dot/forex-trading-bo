"use strict";

const logger = require('winston');

class MomentumStrategy {
  constructor() {
    this.name = 'Momentum';
    this.parameters = {
      momentum_period: 10,
      rsi_period: 14,
      stop_loss_pct: 0.02,
      take_profit_pct: 0.04,
      overbought_threshold: 70,
      oversold_threshold: 30
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
      
      // Calculate momentum and RSI
      const momentum = this.calculateMomentum(prices, params.momentum_period);
      const rsi = this.calculateRSI(prices, params.rsi_period);
      
      // Generate signals based on momentum and RSI
      const signals = this.generateSignals(momentum, rsi, params);
      
      // Execute trades based on signals
      const position = await this.executeTrade(portfolio, symbol, signals, initial_balance, position_size, params);
      
      logger.info(`Momentum Strategy executed for ${symbol}: ${position ? 'Position opened' : 'No position taken'}`);
      return position;
    } catch (error) {
      logger.error(`Error in Momentum Strategy for ${symbol}:`, error.message);
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
      const trend = Math.sin(i * 0.1) * 0.005; // Some trend component
      const change = trend + (Math.random() - 0.5) * 2 * volatility;
      const price = basePrice * (1 + change);
      data.push({
        timestamp: new Date(Date.now() - (99 - i) * 60000), // 1-minute intervals
        price: price
      });
      basePrice = price;
    }
    
    return data;
  }

  calculateMomentum(prices, period) {
    const values = prices.map(d => d.price);
    const momentum = [];

    if (!Number.isInteger(period) || period <= 0) return momentum;
    
    for (let i = period; i < values.length; i++) {
      const mom = (values[i] / values[i - period]) - 1;
      momentum.push(mom);
    }
    
    return momentum;
  }

  calculateRSI(prices, period) {
    const values = prices.map(d => d.price);
    if (!Number.isInteger(period) || period <= 0 || values.length <= period) return [];

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i += 1) {
      const change = values[i] - values[i - 1];
      if (change > 0) {
        avgGain += change;
      } else {
        avgLoss += Math.abs(change);
      }
    }
    
    avgGain /= period;
    avgLoss /= period;

    const rsiValues = [this.getRSIValue(avgGain, avgLoss)];
    for (let i = period + 1; i < values.length; i += 1) {
      const change = values[i] - values[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsiValues.push(this.getRSIValue(avgGain, avgLoss));
    }

    return rsiValues;
  }

  getRSIValue(avgGain, avgLoss) {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    const relativeStrength = avgGain / avgLoss;
    return 100 - (100 / (1 + relativeStrength));
  }

  generateSignals(momentum, rsi, params) {
    const currentMomentum = momentum[momentum.length - 1];
    const currentRSI = rsi[rsi.length - 1];

    if (!Number.isFinite(currentMomentum) || !Number.isFinite(currentRSI)) {
      return { action: 'HOLD', strength: 0, timestamp: new Date().toISOString() };
    }
    
    // Momentum strategy logic
    if (currentMomentum > 0.01 && currentRSI > params.overbought_threshold) {
      // Strong upward momentum with overbought RSI - potential continuation
      return {
        action: 'BUY',
        strength: Math.min(currentMomentum * 100, 10),
        timestamp: new Date().toISOString()
      };
    } else if (currentMomentum < -0.01 && currentRSI < params.oversold_threshold) {
      // Strong downward momentum with oversold RSI - potential bounce
      return {
        action: 'SELL',
        strength: Math.min(Math.abs(currentMomentum) * 100, 10),
        timestamp: new Date().toISOString()
      };
    } else if (currentRSI < params.oversold_threshold) {
      // Oversold conditions - buy signal
      return {
        action: 'BUY',
        strength: Math.max(0, (params.oversold_threshold - currentRSI) / 10),
        timestamp: new Date().toISOString()
      };
    } else if (currentRSI > params.overbought_threshold) {
      // Overbought conditions - sell signal
      return {
        action: 'SELL',
        strength: Math.max(0, (currentRSI - params.overbought_threshold) / 10),
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
      description: 'Momentum-based strategy using price momentum and RSI',
      recommended_symbols: ['EUR/USD', 'GBP/USD', 'USD/JPY'],
      timeframe: 'M1'
    };
  }
}

module.exports = MomentumStrategy;