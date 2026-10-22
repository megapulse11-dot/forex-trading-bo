"use strict";

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('winston', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const OANDAAPI = require('../src/api/OANDAAPI');
const { OrderService } = require('../src/trading/OrderService');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createService(broker) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-order-journal-'));
  temporaryDirectories.push(directory);
  return new OrderService(broker, path.join(directory, 'orders.json'));
}

const validRequest = overrides => ({
  instrument: 'EUR_USD',
  side: 'BUY',
  units: 100,
  stopLoss: 1.09,
  takeProfit: 1.12,
  confirmation: 'PLACE PRACTICE ORDER',
  clientRequestId: 'e57483a9-a928-4cdd-b7c7-06727041e372',
  ...overrides
});

function createBroker(overrides = {}) {
  const broker = {
    environment: 'practice',
    isConfigured: jest.fn(() => true),
    canExecuteOrders: jest.fn(() => true),
    getOpenTrades: jest.fn(async () => ({ trades: [] })),
    getPricing: jest.fn(async () => ({
      prices: [{
        instrument: 'EUR_USD',
        status: 'tradeable',
        time: new Date().toISOString(),
        bids: [{ price: '1.1000' }],
        asks: [{ price: '1.1002' }],
        quoteHomeConversionFactors: { negativeUnits: '1', positiveUnits: '1' }
      }]
    })),
    getAccountSummary: jest.fn(async () => ({ NAV: '10000', marginAvailable: '9000', currency: 'USD' })),
    getInstruments: jest.fn(async () => ({
      instruments: [{
        name: 'EUR_USD',
        minimumTradeSize: '1',
        maximumOrderUnits: '100000',
        displayPrecision: 5,
        marginRate: '0.02'
      }]
    })),
    createOrder: jest.fn(async (payload, clientRequestId) => ({
      orderCreateTransaction: { id: 'practice-1' },
      orderFillTransaction: { tradeOpened: { tradeID: 'trade-1' } },
      payload,
      clientRequestId
    })),
    ...overrides
  };
  return broker;
}

describe('OANDA live-safety boundary', () => {
  test('defaults to the practice hostname and ignores arbitrary host overrides', () => {
    const adapter = new OANDAAPI({
      OANDA_ENVIRONMENT: 'practice',
      OANDA_API_URL: 'https://attacker.invalid/v3'
    }, {});

    expect(adapter.baseURL).toBe('https://api-fxpractice.oanda.com/v3');
    expect(adapter.canExecuteOrders()).toBe(false);
  });

  test('live order execution needs both server enablement and explicit acknowledgement', () => {
    const base = {
      OANDA_ENVIRONMENT: 'live',
      OANDA_ACCOUNT_ID: 'account',
      OANDA_ACCESS_TOKEN: 'token',
      TRADING_ENABLED: 'true'
    };
    const httpClient = { post: jest.fn(), get: jest.fn() };
    const unacknowledged = new OANDAAPI(base, httpClient);
    const acknowledged = new OANDAAPI({
      ...base,
      LIVE_TRADING_ACKNOWLEDGED: 'I_ACCEPT_REAL_MONEY_RISK'
    }, httpClient);

    expect(unacknowledged.baseURL).toBe('https://api-fxtrade.oanda.com/v3');
    expect(unacknowledged.canExecuteOrders()).toBe(false);
    expect(acknowledged.canExecuteOrders()).toBe(true);
  });

  test('rejects arbitrary OANDA environments', () => {
    expect(() => new OANDAAPI({ OANDA_ENVIRONMENT: 'custom' }, {})).toThrow('must be practice or live');
  });

  test('requires stop-loss and take-profit on every broker market order', async () => {
    const httpClient = { post: jest.fn(), get: jest.fn() };
    const adapter = new OANDAAPI({
      OANDA_ENVIRONMENT: 'practice',
      OANDA_ACCOUNT_ID: 'account',
      OANDA_ACCESS_TOKEN: 'token',
      TRADING_ENABLED: 'true'
    }, httpClient);

    await expect(adapter.createOrder({ order: { type: 'MARKET' } })).rejects.toThrow('attached stop-loss');
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  test('sends the request ID to OANDA for transaction correlation', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: { orderCreateTransaction: { id: '42' } } })) };
    const adapter = new OANDAAPI({
      OANDA_ENVIRONMENT: 'practice',
      OANDA_ACCOUNT_ID: 'account',
      OANDA_ACCESS_TOKEN: 'token',
      TRADING_ENABLED: 'true'
    }, httpClient);
    const requestId = 'e57483a9-a928-4cdd-b7c7-06727041e372';

    await adapter.createOrder({ order: {
      type: 'MARKET',
      stopLossOnFill: { price: '1.0' },
      takeProfitOnFill: { price: '1.2' }
    } }, requestId);

    expect(httpClient.post.mock.calls[0][2].headers.ClientRequestID).toBe(requestId);
  });

  test('filters OANDA instrument metadata using the documented query parameter', async () => {
    const httpClient = { get: jest.fn(async () => ({ data: { instruments: [] } })) };
    const adapter = new OANDAAPI({
      OANDA_ENVIRONMENT: 'practice',
      OANDA_ACCOUNT_ID: 'account',
      OANDA_ACCESS_TOKEN: 'token'
    }, httpClient);

    await adapter.getInstruments(['EUR_USD']);

    expect(httpClient.get.mock.calls[0][0]).toBe(
      'https://api-fxpractice.oanda.com/v3/accounts/account/instruments?instruments=EUR_USD'
    );
  });
});

describe('OrderService', () => {
  test('sends one protected practice order and de-duplicates retries', async () => {
    const broker = createBroker();
    const service = createService(broker);
    const request = validRequest();

    const first = await service.placeOrder(request);
    const restartedService = new OrderService(broker, service.journalPath);
    const retry = await restartedService.placeOrder(request);

    expect(first.brokerResponse.payload.order).toMatchObject({
      units: '100',
      instrument: 'EUR_USD',
      type: 'MARKET',
      stopLossOnFill: { price: '1.09000', timeInForce: 'GTC' },
      takeProfitOnFill: { price: '1.12000', timeInForce: 'GTC' }
    });
    expect(retry.duplicate).toBe(true);
    expect(broker.createOrder).toHaveBeenCalledTimes(1);
    expect(restartedService.listRecentOrders()[0]).toMatchObject({
      status: 'SUBMITTED',
      brokerOrderId: 'practice-1'
    });
  });

  test('rejects orders exceeding the account NAV risk cap before broker submission', async () => {
    const broker = createBroker();
    const service = createService(broker);

    await expect(service.placeOrder(validRequest({ units: 1000, stopLoss: 0.99 })))
      .rejects.toThrow('1% account NAV limit');
    expect(broker.createOrder).not.toHaveBeenCalled();
  });

  test('rejects stale quotes and incorrectly placed protective exits', async () => {
    const staleBroker = createBroker({
      getPricing: jest.fn(async () => ({
        prices: [{
          instrument: 'EUR_USD',
          status: 'tradeable',
          time: new Date(Date.now() - 60000).toISOString(),
          bids: [{ price: '1.1000' }],
          asks: [{ price: '1.1002' }]
        }]
      }))
    });
    await expect(createService(staleBroker).placeOrder(validRequest())).rejects.toThrow('quote is stale');

    const broker = createBroker();
    await expect(createService(broker).placeOrder(validRequest({ stopLoss: 1.101 })))
      .rejects.toThrow('correct side');
    expect(broker.createOrder).not.toHaveBeenCalled();
  });

  test('requires the live-specific typed confirmation', async () => {
    const broker = createBroker({ environment: 'live' });
    await expect(createService(broker).placeOrder(validRequest()))
      .rejects.toThrow('PLACE LIVE ORDER');
    expect(broker.getPricing).not.toHaveBeenCalled();
  });

  test('adds existing open-trade risk before accepting another order', async () => {
    const broker = createBroker({
      getOpenTrades: jest.fn(async () => ({
        trades: [{
          id: 'existing-1',
          instrument: 'EUR_USD',
          currentUnits: '10000',
          price: '1.1000',
          stopLossOrder: { price: '1.0900' }
        }]
      }))
    });

    await expect(createService(broker).placeOrder(validRequest()))
      .rejects.toThrow('Combined open-trade and proposed stop-loss risk');
    expect(broker.createOrder).not.toHaveBeenCalled();
  });

  test('halts new requests after an ambiguous broker timeout, including after restart', async () => {
    const broker = createBroker({ createOrder: jest.fn(async () => { throw new Error('socket timed out'); }) });
    const service = createService(broker);
    await expect(service.placeOrder(validRequest())).rejects.toThrow('socket timed out');

    const restartedService = new OrderService(broker, service.journalPath);
    await expect(restartedService.placeOrder(validRequest({
      clientRequestId: 'b183cbd8-a4c3-4c98-a870-8873396757a1'
    }))).rejects.toThrow('reconcile the earlier uncertain broker request');
    expect(restartedService.listRecentOrders()[0].status).toBe('UNKNOWN');
    expect(broker.createOrder).toHaveBeenCalledTimes(1);
  });

  test('treats an incomplete broker success response as uncertain', async () => {
    const broker = createBroker({ createOrder: jest.fn(async () => ({})) });
    const service = createService(broker);

    await expect(service.placeOrder(validRequest())).rejects.toThrow('inspect OANDA activity');
    expect(service.listRecentOrders()[0].status).toBe('UNKNOWN');
    expect(service.hasUncertainOrders()).toBe(true);
  });
});