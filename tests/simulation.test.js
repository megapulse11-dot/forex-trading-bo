"use strict";

const { SimulationEngine, SimulationError, MAX_ORDER_UNITS } = require('../src/trading/SimulationEngine');

const confirmation = 'PLACE SIMULATED ORDER';

function makeEngine(options = {}) {
  return new SimulationEngine({
    rateProvider: {
      getLatestRates: jest.fn(async () => ({
        rates: { EUR: 0.9, GBP: 0.8, JPY: 150, AUD: 1.5, CAD: 1.4, CHF: 0.9 }
      }))
    },
    random: () => 0.5, // no shock: the walk only mean-reverts
    ...options
  });
}

function order(overrides = {}) {
  return {
    instrument: 'EUR_USD',
    side: 'BUY',
    units: 100,
    stopLoss: 1.05,
    takeProfit: 1.2,
    confirmation,
    clientRequestId: 'req-1',
    ...overrides
  };
}

describe('simulation venue', () => {
  test('derives mid prices from the USD cross table and quotes a two-sided market', async () => {
    const engine = makeEngine();
    await engine.refreshAnchors();
    const quote = engine.getQuote('EUR_USD');

    // 1 USD = 0.9 EUR -> EUR_USD = 1 / 0.9
    expect(quote.mid).toBeCloseTo(1 / 0.9, 6);
    expect(quote.status).toBe('tradeable');
    expect(quote.source).toBe('SIMULATED');
    expect(quote.bid).toBeLessThan(quote.ask);
    expect(engine.getQuote('USD_JPY').mid).toBeCloseTo(150, 6);
    expect(engine.getQuote('EUR_GBP').mid).toBeCloseTo(0.8 / 0.9, 6);
  });

  test('re-anchors to fetched reference rates without leaving a stale level', async () => {
    const engine = makeEngine();
    const before = engine.getQuote('EUR_USD').mid;
    await engine.refreshAnchors();

    expect(engine.anchorSource).toBe('ECB_REFERENCE');
    // Fallback table says 0.92, the provider says 0.9, so the level must move.
    expect(before).not.toBeCloseTo(engine.getQuote('EUR_USD').mid, 6);
    expect(engine.getQuote('EUR_USD').mid).toBeCloseTo(1 / 0.9, 6);
    expect(engine.getQuote('EUR_USD').changePercent).toBeCloseTo(0, 6);
  });

  test('fills an order, opens a position and marks it to market', () => {
    const engine = makeEngine();
    const result = engine.placeOrder(order());

    expect(result.status).toBe('FILLED');
    expect(result.price).toBeCloseTo(engine.getQuote('EUR_USD').ask, 6);

    const positions = engine.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ instrument: 'EUR_USD', side: 'BUY', units: 100, status: 'OPEN' });

    const account = engine.getAccount();
    expect(account.openTradeCount).toBe(1);
    expect(account.marginUsed).toBeGreaterThan(0);
    expect(account.NAV).toBeCloseTo(10000, 2);
    expect(engine.getJournal()).toHaveLength(1);
  });

  test('refuses the order without the exact typed confirmation', () => {
    const engine = makeEngine();
    expect(() => engine.placeOrder(order({ confirmation: 'PLACE ORDER' })))
      .toThrow(SimulationError);
    expect(() => engine.placeOrder(order({ confirmation: 'PLACE ORDER' })))
      .toThrow('PLACE SIMULATED ORDER');
    expect(engine.getPositions()).toHaveLength(0);
  });

  test('does not fill the same client request id twice', () => {
    const engine = makeEngine();
    const first = engine.placeOrder(order());
    const replay = engine.placeOrder(order());

    expect(first.status).toBe('FILLED');
    expect(replay.duplicate).toBe(true);
    expect(engine.getPositions()).toHaveLength(1);
    expect(engine.getJournal()).toHaveLength(1);
  });

  test('caps size, rejects mis-placed exits and rejects unknown instruments', () => {
    const engine = makeEngine();

    expect(() => engine.placeOrder(order({ units: MAX_ORDER_UNITS + 1 }))).toThrow('capped at');
    expect(() => engine.placeOrder(order({ units: 10.5 }))).toThrow('whole number');
    expect(() => engine.placeOrder(order({ stopLoss: 1.3, takeProfit: 1.4 }))).toThrow('below the buy entry');
    expect(() => engine.placeOrder(order({ stopLoss: 1.05, takeProfit: 1.0, side: 'SELL' })))
      .toThrow('above the sell entry');
    expect(() => engine.placeOrder(order({ instrument: 'GBP_JPY' }))).toThrow('supported instrument');
    expect(engine.getPositions()).toHaveLength(0);
  });

  test('rejects stop risk above 1% of NAV before anything is filled', () => {
    const engine = makeEngine({ initialBalance: 500 });

    // 1000 units x 0.037 of entry risk is $37 against a $5 budget on $500.
    expect(() => engine.placeOrder(order({ units: 1000, stopLoss: 1.05, takeProfit: 1.2 })))
      .toThrow('1% account NAV limit');
    expect(engine.getPositions()).toHaveLength(0);
    expect(engine.getJournal()).toHaveLength(0);
  });

  test('ticks keep the walk inside the anchor band and preserve the spread', () => {
    const engine = makeEngine({ random: () => 1 });
    const anchor = engine.getQuote('EUR_USD').anchor;

    for (let i = 0; i < 500; i += 1) engine.tick();
    const quote = engine.getQuote('EUR_USD');

    expect(quote.bid).toBeLessThan(quote.ask);
    expect(quote.mid).toBeLessThanOrEqual(anchor * 1.02);
    expect(quote.mid).toBeGreaterThanOrEqual(anchor * 0.98);
  });
});
