"use strict";

const fs = require('node:fs');
const path = require('node:path');

const MAX_ORDER_UNITS = 1000;
const MAX_RISK_FRACTION = 0.01;
const MAX_QUOTE_AGE_MS = 15000;

class OrderServiceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderService {
  constructor(broker, journalPath = path.resolve(__dirname, '../../logs/order-journal.json')) {
    this.broker = broker;
    this.journalPath = journalPath;
    this.journal = new Map();
    this.pendingRequests = new Set();
    this.executionQueue = Promise.resolve();
    this.loadJournal();
  }

  loadJournal() {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(this.journalPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`Cannot safely load order journal: ${error.message}`);
    }

    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('Cannot safely load order journal: expected an order map');
    }
    for (const [requestId, record] of Object.entries(entries)) {
      if (!record || !['SUBMITTING', 'UNKNOWN', 'REJECTED', 'SUBMITTED'].includes(record.status)) {
        throw new Error(`Cannot safely load order journal: invalid record for ${requestId}`);
      }
      this.journal.set(requestId, record);
    }
  }

  persistJournal() {
    const directory = path.dirname(this.journalPath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.journalPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(this.journal), null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, this.journalPath);
  }

  hasUncertainOrders() {
    return Array.from(this.journal.values()).some(record => (
      record.status === 'SUBMITTING' || record.status === 'UNKNOWN'
    ));
  }

  listRecentOrders(limit = 20) {
    return Array.from(this.journal.entries())
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(([clientRequestId, record]) => ({
        clientRequestId,
        status: record.status,
        instrument: record.request.instrument,
        side: record.request.side,
        units: record.request.units,
        updatedAt: record.updatedAt,
        brokerOrderId: record.result?.brokerOrderId,
        error: record.error
      }));
  }

  placeOrder(input) {
    const execute = () => this.placeOrderSerial(input);
    const result = this.executionQueue.then(execute, execute);
    this.executionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async placeOrderSerial(input) {
    const request = this.validateInput(input);
    if (!this.broker.isConfigured()) {
      throw new OrderServiceError('Connect an OANDA account before placing orders', 503);
    }
    if (!this.broker.canExecuteOrders()) {
      throw new OrderServiceError('Order execution is disabled by server configuration', 403);
    }

    const expectedConfirmation = this.broker.environment === 'live'
      ? 'PLACE LIVE ORDER'
      : 'PLACE PRACTICE ORDER';
    if (request.confirmation !== expectedConfirmation) {
      throw new OrderServiceError(`Type ${expectedConfirmation} to confirm this order`, 400);
    }

    const previous = this.journal.get(request.clientRequestId);
    if (previous?.status === 'SUBMITTED') return { ...previous.result, duplicate: true };
    if (previous?.status === 'REJECTED') {
      throw new OrderServiceError('This request ID was rejected; review the rejection and create a new request ID', 409);
    }
    if (previous || this.pendingRequests.has(request.clientRequestId)) {
      throw new OrderServiceError('This order request is already being processed', 409);
    }
    if (this.hasUncertainOrders()) {
      throw new OrderServiceError('Order flow is halted: reconcile the earlier uncertain broker request before sending another order', 503);
    }

    this.pendingRequests.add(request.clientRequestId);
    try {
      return await this.submitValidatedOrder(request);
    } finally {
      this.pendingRequests.delete(request.clientRequestId);
    }
  }

  validateInput(input) {
    if (!input || typeof input !== 'object') {
      throw new OrderServiceError('Order details are required');
    }

    const { instrument, side, units, stopLoss, takeProfit, confirmation, clientRequestId } = input;
    if (typeof instrument !== 'string' || !/^[A-Z]{3}_[A-Z]{3}$/.test(instrument)) {
      throw new OrderServiceError('Choose a valid OANDA instrument');
    }
    if (!['BUY', 'SELL'].includes(side)) throw new OrderServiceError('Side must be BUY or SELL');
    if (!Number.isInteger(units) || units < 1 || units > MAX_ORDER_UNITS) {
      throw new OrderServiceError(`Units must be an integer between 1 and ${MAX_ORDER_UNITS}`);
    }
    if (!Number.isFinite(stopLoss) || stopLoss <= 0 ||
        !Number.isFinite(takeProfit) || takeProfit <= 0) {
      throw new OrderServiceError('A positive stop loss and take profit are required');
    }
    if (typeof clientRequestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
      throw new OrderServiceError('A unique order request ID is required');
    }

    return { instrument, side, units, stopLoss, takeProfit, confirmation, clientRequestId };
  }

  async submitValidatedOrder(request) {
    const [account, instrumentResponse, openTradesResponse] = await Promise.all([
      this.broker.getAccountSummary(),
      this.broker.getInstruments([request.instrument]),
      this.broker.getOpenTrades()
    ]);
    const instrument = instrumentResponse.instruments && instrumentResponse.instruments[0];
    if (!instrument || instrument.name !== request.instrument) {
      throw new OrderServiceError('Broker returned no matching instrument metadata', 422);
    }

    const openTrades = openTradesResponse.trades || [];
    const instruments = Array.from(new Set([
      request.instrument,
      ...openTrades.map(trade => trade.instrument).filter(name => /^[A-Z]{3}_[A-Z]{3}$/.test(name || ''))
    ]));
    const pricingResponse = await this.broker.getPricing(instruments);
    const prices = new Map((pricingResponse.prices || []).map(price => [price.instrument, price]));
    const quote = prices.get(request.instrument);
    if (!quote) throw new OrderServiceError('Broker returned no matching price', 422);
    if (quote.status !== 'tradeable') throw new OrderServiceError('This instrument is not currently tradeable', 422);

    const quoteTime = Date.parse(quote.time);
    if (!Number.isFinite(quoteTime) || Date.now() - quoteTime > MAX_QUOTE_AGE_MS || quoteTime > Date.now() + 5000) {
      throw new OrderServiceError('The broker quote is stale; refresh before ordering', 422);
    }

    const bid = Number(quote.bids?.[0]?.price);
    const ask = Number(quote.asks?.[0]?.price);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) {
      throw new OrderServiceError('Broker returned an invalid bid/ask quote', 422);
    }

    const entryPrice = request.side === 'BUY' ? ask : bid;
    const isBuy = request.side === 'BUY';
    if ((isBuy && (request.stopLoss >= entryPrice || request.takeProfit <= entryPrice)) ||
        (!isBuy && (request.stopLoss <= entryPrice || request.takeProfit >= entryPrice))) {
      throw new OrderServiceError('Stop loss and take profit must be on the correct side of the entry price');
    }

    const minimumUnits = Number(instrument.minimumTradeSize);
    const venueMaximum = Number(instrument.maximumOrderUnits);
    if (!Number.isFinite(minimumUnits) || request.units < minimumUnits ||
        (Number.isFinite(venueMaximum) && request.units > venueMaximum)) {
      throw new OrderServiceError('Order size is outside this instrument’s broker limits');
    }

    const nav = Number(account.NAV);
    const marginAvailable = Number(account.marginAvailable);
    const positiveConversion = Number(quote.quoteHomeConversionFactors?.positiveUnits);
    const negativeConversion = Number(quote.quoteHomeConversionFactors?.negativeUnits);
    const riskConversion = Math.max(positiveConversion, negativeConversion);
    const marginRate = Number(instrument.marginRate);
    if (!Number.isFinite(nav) || nav <= 0 || !Number.isFinite(marginAvailable) || marginAvailable <= 0 ||
        !Number.isFinite(positiveConversion) || positiveConversion <= 0 ||
        !Number.isFinite(negativeConversion) || negativeConversion <= 0 ||
        !Number.isFinite(marginRate) || marginRate <= 0) {
      throw new OrderServiceError('Account or conversion data is incomplete; order was not sent', 422);
    }

    const notionalConversion = Math.max(positiveConversion, negativeConversion);
    const estimatedMargin = request.units * entryPrice * notionalConversion * marginRate;
    if (!Number.isFinite(estimatedMargin) || estimatedMargin > marginAvailable * 0.9) {
      throw new OrderServiceError('Insufficient free margin after the 10% reserve', 422);
    }

    const precision = Number(instrument.displayPrecision);
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) {
      throw new OrderServiceError('Broker returned invalid instrument precision', 422);
    }

    const scale = 10 ** precision;
    const quantize = (price, direction) => {
      const scaledPrice = price * scale;
      const rounded = direction === 'down' ? Math.floor(scaledPrice + 1e-9) : Math.ceil(scaledPrice - 1e-9);
      return Number((rounded / scale).toFixed(precision));
    };
    const stopLoss = quantize(request.stopLoss, isBuy ? 'down' : 'up');
    const takeProfit = quantize(request.takeProfit, isBuy ? 'up' : 'down');
    if ((isBuy && (stopLoss >= entryPrice || takeProfit <= entryPrice)) ||
        (!isBuy && (stopLoss <= entryPrice || takeProfit >= entryPrice))) {
      throw new OrderServiceError('Price precision would place a protective order on the wrong side of entry');
    }

    const riskAmount = request.units * Math.abs(entryPrice - stopLoss) * riskConversion;
    let existingRisk = 0;
    for (const trade of openTrades) {
      const openUnits = Math.abs(Number(trade.currentUnits));
      if (!Number.isFinite(openUnits)) throw new OrderServiceError('Existing broker trade has invalid units', 422);
      if (openUnits === 0) continue;

      const openPrice = Number(trade.price);
      const existingStop = Number(trade.stopLossOrder?.price);
      const tradeQuote = prices.get(trade.instrument);
      const existingQuoteTime = Date.parse(tradeQuote?.time);
      const positiveTradeConversion = Number(tradeQuote?.quoteHomeConversionFactors?.positiveUnits);
      const negativeTradeConversion = Number(tradeQuote?.quoteHomeConversionFactors?.negativeUnits);
      const conversion = Math.max(positiveTradeConversion, negativeTradeConversion);
      if (!tradeQuote || !Number.isFinite(openPrice) || openPrice <= 0 ||
          !Number.isFinite(existingStop) || existingStop <= 0 ||
          !Number.isFinite(existingQuoteTime) || Date.now() - existingQuoteTime > MAX_QUOTE_AGE_MS ||
          !Number.isFinite(positiveTradeConversion) || positiveTradeConversion <= 0 ||
          !Number.isFinite(negativeTradeConversion) || negativeTradeConversion <= 0) {
        throw new OrderServiceError(`Existing trade ${trade.id} lacks a verifiable protective stop; new orders are blocked`, 409);
      }
      existingRisk += openUnits * Math.abs(openPrice - existingStop) * conversion;
    }

    if ((riskAmount + existingRisk) / nav > MAX_RISK_FRACTION) {
      throw new OrderServiceError('Combined open-trade and proposed stop-loss risk exceeds the 1% account NAV limit', 422);
    }

    const signedUnits = isBuy ? request.units : -request.units;
    const payload = {
      order: {
        units: String(signedUnits),
        instrument: request.instrument,
        timeInForce: 'FOK',
        type: 'MARKET',
        positionFill: 'DEFAULT',
        stopLossOnFill: { price: stopLoss.toFixed(precision), timeInForce: 'GTC' },
        takeProfitOnFill: { price: takeProfit.toFixed(precision), timeInForce: 'GTC' }
      }
    };

    const journalEntry = {
      status: 'SUBMITTING',
      request: {
        instrument: request.instrument,
        side: request.side,
        units: request.units,
        stopLoss,
        takeProfit
      },
      updatedAt: Date.now()
    };
    this.journal.set(request.clientRequestId, journalEntry);
    this.persistJournal();

    let brokerResponse;
    try {
      brokerResponse = await this.broker.createOrder(payload, request.clientRequestId);
    } catch (error) {
      journalEntry.status = error.statusCode >= 400 && error.statusCode < 500 ? 'REJECTED' : 'UNKNOWN';
      journalEntry.error = error.message;
      journalEntry.updatedAt = Date.now();
      this.persistJournal();
      throw error;
    }

    if (!brokerResponse?.orderCreateTransaction?.id) {
      journalEntry.status = 'UNKNOWN';
      journalEntry.error = 'Broker response did not include an order-create transaction ID';
      journalEntry.updatedAt = Date.now();
      this.persistJournal();
      throw new OrderServiceError('Broker response was incomplete; inspect OANDA activity before retrying', 502);
    }

    const result = {
      clientRequestId: request.clientRequestId,
      instrument: request.instrument,
      side: request.side,
      units: request.units,
      quotedPrice: entryPrice,
      estimatedRisk: riskAmount,
      existingOpenRisk: existingRisk,
      currency: account.currency,
      brokerOrderId: brokerResponse.orderCreateTransaction?.id,
      brokerResponse
    };
    journalEntry.status = 'SUBMITTED';
    journalEntry.result = result;
    journalEntry.updatedAt = Date.now();
    this.persistJournal();
    return result;
  }
}

module.exports = { OrderService, OrderServiceError };