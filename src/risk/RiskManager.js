"use strict";

const logger = require('winston');

class RiskManager {
  constructor() {
    this.riskLimits = {
      max_portfolio_risk: 0.02, // 2% total portfolio risk
      max_position_size: 0.01, // 1% of portfolio per position
      stop_loss_required: true,
      take_profit_required: true,
      max_drawdown: 0.05, // 5% maximum drawdown
      var_limit: 0.03 // 3% VaR limit
    };
    
    this.portfolioValue = 100000; // Default initial portfolio value
    this.peakPortfolioValue = this.portfolioValue;
    this.currentDrawdown = 0;
    this.varHistory = [];
    this.positionRisks = new Map();
  }

  assessRisk(position, currentPrices) {
    try {
      const validation = this.validatePosition(position);
      if (!validation.valid) throw new Error(validation.errors.join('; '));
      const currentPrice = currentPrices && currentPrices[position.symbol];
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        throw new Error(`A valid current price is required for ${position.symbol}`);
      }

      const risk = {};
      const priceChange = currentPrice - position.entry_price;
      const priceChangePercent = priceChange / position.entry_price;

      risk.position_id = position.id;
      risk.symbol = position.symbol;
      risk.side = position.side;
      risk.entry_price = position.entry_price;
      risk.stop_loss = position.stop_loss;
      risk.take_profit = position.take_profit;
      risk.current_price = currentPrice;
      risk.position_size = position.size * position.entry_price;
      risk.unrealized_pnl = position.size * priceChange * (position.side === 'BUY' ? 1 : -1);
      risk.unrealized_pnl_percent = (risk.unrealized_pnl / (position.size * position.entry_price)) * 100;
      risk.market_risk = Math.abs(priceChangePercent);
      risk.stop_loss_distance = Math.abs(position.stop_loss - position.entry_price) / position.entry_price;
      risk.stop_loss_risk_percent = (position.size * Math.abs(position.stop_loss - position.entry_price)) / this.portfolioValue;
      risk.risk_reward_ratio = risk.stop_loss_distance > 0
        ? Math.abs(position.take_profit - position.entry_price) / Math.abs(position.stop_loss - position.entry_price)
        : 0;
      risk.var_95 = this.calculateVaR(priceChangePercent);
      risk.var_99 = this.calculateVaR(priceChangePercent, 0.99);
      risk.risk_score = this.calculateRiskScore(risk);
      risk.risk_level = this.calculateRiskLevel(risk);
      
      this.positionRisks.set(position.id, risk);
      
      logger.info(`Risk assessment for position ${position.id}: ${risk.risk_level} level, score: ${risk.risk_score}`);
      
      return risk;
    } catch (error) {
      logger.error(`Error assessing risk for position ${position.id}:`, error.message);
      throw error;
    }
  }

  calculateVaR(priceChangePercent, confidence = 0.95) {
    const varValue = priceChangePercent * Math.sqrt(252) * this.getZScore(confidence);
    this.varHistory.push(varValue);
    
    // Keep only recent VaR values
    if (this.varHistory.length > 100) {
      this.varHistory.shift();
    }
    
    return Math.abs(varValue);
  }

  getZScore(confidence) {
    // Z-scores for common confidence levels
    const zScores = {
      0.90: 1.645,
      0.95: 1.96,
      0.99: 2.326
    };
    return zScores[confidence] || 1.96;
  }

  calculateRiskLevel(risk) {
    if (risk.risk_score > 80) return 'HIGH';
    if (risk.risk_score > 60) return 'MEDIUM';
    if (risk.risk_score > 30) return 'LOW';
    return 'MINIMAL';
  }

  calculateRiskScore(risk) {
    let score = 0;
    
    score += Math.min(risk.market_risk * 3000, 30);

    const positionSizeRatio = risk.position_size / this.portfolioValue;
    score += Math.min((positionSizeRatio / this.riskLimits.max_position_size) * 20, 20);
    score += Math.min((risk.stop_loss_risk_percent / this.riskLimits.max_portfolio_risk) * 15, 15);
    score += Math.max(0, 20 - Math.min(risk.risk_reward_ratio, 4) * 5);
    score += Math.min((risk.var_95 / this.riskLimits.var_limit) * 15, 15);

    return Math.min(score, 100);
  }

  canAffordPosition(position, portfolioValue) {
    if (!position || !Number.isFinite(position.size) || !Number.isFinite(position.entry_price) ||
        position.size <= 0 || position.entry_price <= 0 || !Number.isFinite(portfolioValue) || portfolioValue <= 0) {
      return false;
    }
    const positionSize = position.size * position.entry_price;
    const maxPositionSize = portfolioValue * this.riskLimits.max_position_size;
    
    return positionSize <= maxPositionSize;
  }

  setStopLoss(positionId, stopLossPrice) {
    const risk = this.positionRisks.get(positionId);
    if (!risk) {
      throw new Error(`Position ${positionId} not found in risk registry`);
    }
    if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
      throw new Error('Stop loss must be a positive number');
    }
    if ((risk.side === 'BUY' && stopLossPrice >= risk.entry_price) ||
        (risk.side === 'SELL' && stopLossPrice <= risk.entry_price)) {
      throw new Error(`Stop loss is on the wrong side of entry for ${risk.side}`);
    }

    risk.stop_loss = stopLossPrice;
    risk.stop_loss_distance = Math.abs(stopLossPrice - risk.current_price) / risk.current_price;
    risk.stop_loss_risk_percent = (risk.position_size / risk.entry_price * Math.abs(stopLossPrice - risk.entry_price)) / this.portfolioValue;
    
    logger.info(`Stop loss set for position ${positionId}: ${stopLossPrice}`);
  }

  updateDrawdown(currentValue) {
    if (!Number.isFinite(currentValue) || currentValue <= 0) {
      throw new Error('Portfolio value must be a positive number');
    }

    this.portfolioValue = currentValue;
    this.peakPortfolioValue = Math.max(this.peakPortfolioValue, currentValue);
    this.currentDrawdown = (this.peakPortfolioValue - currentValue) / this.peakPortfolioValue;

    if (this.currentDrawdown > this.riskLimits.max_drawdown) {
      logger.warn(`Drawdown alert: ${(this.currentDrawdown * 100).toFixed(2)}% exceeded limit of ${(this.riskLimits.max_drawdown * 100).toFixed(2)}%`);
    }
  }

  getRiskAssessment() {
    return {
      portfolio_value: this.portfolioValue,
      current_drawdown: this.currentDrawdown,
      current_drawdown_percent: (this.currentDrawdown * 100).toFixed(2),
      var_history: this.varHistory,
      position_risks: Array.from(this.positionRisks.values()),
      risk_limits: this.riskLimits,
      timestamp: new Date().toISOString()
    };
  }

  validatePosition(position) {
    const errors = [];
    if (!position || typeof position !== 'object') {
      return { valid: false, errors: ['Position is required'] };
    }

    if (!position.id) errors.push('Position id is required');
    if (!position.symbol) errors.push('Symbol is required');
    if (!position.side || !['BUY', 'SELL'].includes(position.side)) errors.push('Valid side (BUY/SELL) is required');
    if (!Number.isFinite(position.size) || position.size <= 0) errors.push('Valid position size is required');
    if (!Number.isFinite(position.entry_price) || position.entry_price <= 0) errors.push('Valid entry price is required');
    if (!Number.isFinite(position.stop_loss) || position.stop_loss <= 0) errors.push('Valid stop loss is required');
    if (!Number.isFinite(position.take_profit) || position.take_profit <= 0) errors.push('Valid take profit is required');

    if (Number.isFinite(position.entry_price) && Number.isFinite(position.stop_loss) &&
        position.side === 'BUY' && position.stop_loss >= position.entry_price) {
      errors.push('Stop loss must be below entry price for BUY positions');
    }
    if (Number.isFinite(position.entry_price) && Number.isFinite(position.stop_loss) &&
        position.side === 'SELL' && position.stop_loss <= position.entry_price) {
      errors.push('Stop loss must be above entry price for SELL positions');
    }
    if (Number.isFinite(position.entry_price) && Number.isFinite(position.take_profit) &&
        position.side === 'BUY' && position.take_profit <= position.entry_price) {
      errors.push('Take profit must be above entry price for BUY positions');
    }
    if (Number.isFinite(position.entry_price) && Number.isFinite(position.take_profit) &&
        position.side === 'SELL' && position.take_profit >= position.entry_price) {
      errors.push('Take profit must be below entry price for SELL positions');
    }
    
    return {
      valid: errors.length === 0,
      errors: errors
    };
  }
}

module.exports = RiskManager;