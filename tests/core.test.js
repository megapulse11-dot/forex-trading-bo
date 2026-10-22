"use strict";

jest.mock('winston', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const Backtester = require('../src/backtest/Backtester');
const BollingerBandsStrategy = require('../src/strategies/BollingerBandsStrategy');
const MomentumStrategy = require('../src/strategies/MomentumStrategy');
const Portfolio = require('../src/portfolio/Portfolio');
const RiskManager = require('../src/risk/RiskManager');
const SMAStrategy = require('../src/strategies/SMAStrategy');

describe('trading bot core', () => {
  test('portfolio tracks unrealized and realized P&L', () => {
    const portfolio = new Portfolio(1000);
    portfolio.addPosition({
      id: 'trade-1',
      symbol: 'EUR/USD',
      side: 'BUY',
      size: 100,
      entry_price: 1.1
    });
    portfolio.updatePositionPrice('trade-1', 1.11);

    expect(portfolio.getSummary().unrealized_pnl).toBeCloseTo(1);
    expect(portfolio.closePosition('trade-1', 1.12).realized_pnl).toBeCloseTo(2);
    expect(portfolio.getSummary().equity).toBeCloseTo(1002);
    expect(portfolio.getPositions()).toHaveLength(0);
  });

  test('risk assessment scores positions and validates SELL exits directionally', () => {
    const manager = new RiskManager();
    const position = {
      id: 'trade-2',
      symbol: 'EUR/USD',
      side: 'SELL',
      size: 1000,
      entry_price: 1.1,
      stop_loss: 1.12,
      take_profit: 1.06
    };

    expect(manager.validatePosition(position).valid).toBe(true);
    expect(manager.validatePosition({ ...position, take_profit: 1.12 }).valid).toBe(false);
    const assessment = manager.assessRisk(position, { 'EUR/USD': 1.09 });
    expect(assessment.position_size).toBeCloseTo(1100);
    expect(Number.isFinite(assessment.risk_score)).toBe(true);
    expect(['HIGH', 'MEDIUM', 'LOW', 'MINIMAL']).toContain(assessment.risk_level);
  });

  test('strategies produce finite indicators and hold on insufficient history', () => {
    const prices = Array.from({ length: 30 }, (_, index) => ({ price: 1 + index * 0.01 }));
    const sma = new SMAStrategy();
    const bands = new BollingerBandsStrategy().calculateBollingerBands(prices, 20, 2);
    const momentum = new MomentumStrategy();

    expect(sma.calculateSMA(prices, 10)).toBeCloseTo(1.245, 3);
    expect(sma.generateSignals(null, null).action).toBe('HOLD');
    expect(Number.isFinite(bands.upper[bands.upper.length - 1])).toBe(true);
    expect(momentum.calculateRSI(prices, 14).at(-1)).toBe(100);
  });

  test('backtester consumes injected historical rates without network access', async () => {
    const rateProvider = {
      getHistoricalRates: jest.fn().mockResolvedValue({
        rates: {
          '2025-01-01': { USD: 1.0 },
          '2025-01-02': { USD: 2.0 },
          '2025-01-03': { USD: 3.0 },
          '2025-01-04': { USD: 4.0 }
        }
      })
    };
    const strategy = new SMAStrategy();
    strategy.parameters = {
      short_period: 2,
      long_period: 3,
      stop_loss_pct: 0.5,
      take_profit_pct: 0.5
    };

    const result = await new Backtester(rateProvider).runBacktest(
      strategy,
      'EUR/USD',
      '2025-01-01',
      '2025-01-04',
      '1d',
      1000
    );

    expect(rateProvider.getHistoricalRates).toHaveBeenCalledWith('EUR', 'USD', '2025-01-01', '2025-01-04');
    expect(result.total_trades).toBe(1);
    expect(result.final_balance).toBeGreaterThan(1000);
  });
});