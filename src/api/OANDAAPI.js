"use strict";

const axios = require('axios');
const logger = require('winston');

class OANDAAPI {
  constructor(config = process.env, httpClient = axios) {
    this.environment = String(config.OANDA_ENVIRONMENT || 'practice').toLowerCase();
    const baseURLs = {
      practice: 'https://api-fxpractice.oanda.com/v3',
      live: 'https://api-fxtrade.oanda.com/v3'
    };
    if (!baseURLs[this.environment]) {
      throw new Error('OANDA_ENVIRONMENT must be practice or live');
    }

    this.baseURL = baseURLs[this.environment];
    this.accountId = config.OANDA_ACCOUNT_ID;
    this.accessToken = config.OANDA_ACCESS_TOKEN;
    this.tradingEnabled = config.TRADING_ENABLED === 'true';
    this.liveTradingAcknowledged = config.LIVE_TRADING_ACKNOWLEDGED === 'I_ACCEPT_REAL_MONEY_RISK';
    this.httpClient = httpClient;
    this.cache = new Map();
    this.cacheTimeout = 30000; // 30 seconds
    
    if (!this.accountId || !this.accessToken) {
      logger.warn('OANDA account access is not configured.');
    }
  }

  getHeaders() {
    this.assertConfigured();
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'ForexTradingBot/1.0'
    };
  }

  async getAccountSummary() {
    this.assertConfigured();

    try {
      const url = `${this.baseURL}/accounts/${this.accountId}/summary`;
      const response = await this.httpClient.get(url, {
        timeout: 10000,
        headers: this.getHeaders()
      });

      const result = response.data.account;
      logger.info('Fetched OANDA account summary');
      return result;
    } catch (error) {
      logger.error('Error fetching OANDA account summary:', error.message);
      throw new Error(error.response?.data?.errorMessage || 'Failed to fetch OANDA account summary');
    }
  }

  async getInstruments(instruments = null) {
    this.assertConfigured();
    if (instruments !== null && (!Array.isArray(instruments) || instruments.length === 0 ||
        instruments.some(instrument => !/^[A-Z]{3}_[A-Z]{3}$/.test(instrument)))) {
      throw new Error('Valid OANDA instrument names are required');
    }

    const cacheKey = `instruments_${this.accountId}_${instruments ? instruments.join(',') : 'all'}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const query = instruments ? `?${new URLSearchParams({ instruments: instruments.join(',') })}` : '';
      const url = `${this.baseURL}/accounts/${this.accountId}/instruments${query}`;
      const response = await this.httpClient.get(url, {
        timeout: 10000,
        headers: this.getHeaders()
      });

      const result = response.data;
      this.setCache(cacheKey, result);
      logger.info('Fetched OANDA instruments list');
      return result;
    } catch (error) {
      logger.error('Error fetching OANDA instruments:', error.message);
      throw new Error('Failed to fetch OANDA instruments');
    }
  }

  async getPricing(instruments) {
    this.assertConfigured();
    if (!Array.isArray(instruments) || instruments.length === 0 ||
        instruments.some(instrument => !/^[A-Z]{3}_[A-Z]{3}$/.test(instrument))) {
      throw new Error('Valid OANDA instrument names are required');
    }

    try {
      const query = new URLSearchParams({ instruments: instruments.join(',') });
      const url = `${this.baseURL}/accounts/${this.accountId}/pricing?${query}`;
      const response = await this.httpClient.get(url, {
        timeout: 10000,
        headers: this.getHeaders()
      });

      const result = response.data;
      logger.info(`Fetched OANDA pricing for instruments: ${instruments.join(',')}`);
      return result;
    } catch (error) {
      logger.error('Error fetching OANDA pricing:', error.message);
      throw new Error('Failed to fetch OANDA pricing');
    }
  }

  async createOrder(orderData, clientRequestId) {
    if (!this.canExecuteOrders()) {
      throw new Error('Order execution is disabled or not explicitly acknowledged');
    }
    if (!orderData?.order || orderData.order.type !== 'MARKET' ||
        !orderData.order.stopLossOnFill || !orderData.order.takeProfitOnFill) {
      throw new Error('Market orders must include attached stop-loss and take-profit orders');
    }

    try {
      const url = `${this.baseURL}/accounts/${this.accountId}/orders`;
      const headers = this.getHeaders();
      if (clientRequestId) headers.ClientRequestID = clientRequestId;
      const response = await this.httpClient.post(url, orderData, {
        timeout: 15000,
        headers
      });

      logger.info('Order created via OANDA API:', response.data.orderCreateTransaction.id);
      return response.data;
    } catch (error) {
      logger.error('Error creating order via OANDA API:', error.message);
      const brokerError = new Error(error.response?.data?.errorMessage || 'Failed to create order via OANDA API');
      brokerError.statusCode = error.response?.status;
      throw brokerError;
    }
  }

  async getOpenTrades() {
    this.assertConfigured();

    try {
      const url = `${this.baseURL}/accounts/${this.accountId}/openTrades`;
      const response = await this.httpClient.get(url, {
        timeout: 10000,
        headers: this.getHeaders()
      });
      return response.data;
    } catch (error) {
      logger.error('Error fetching OANDA open trades:', error.message);
      throw new Error(error.response?.data?.errorMessage || 'Failed to fetch OANDA open trades');
    }
  }

  async getPositions() {
    this.assertConfigured();

    try {
      const url = `${this.baseURL}/accounts/${this.accountId}/openPositions`;
      const response = await this.httpClient.get(url, {
        timeout: 10000,
        headers: this.getHeaders()
      });

      const result = response.data;
      logger.info('Fetched OANDA positions');
      return result;
    } catch (error) {
      logger.error('Error fetching OANDA positions:', error.message);
      throw new Error('Failed to fetch OANDA positions');
    }
  }

  getFromCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    return null;
  }

  setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    // Limit cache size
    if (this.cache.size > 20) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { status: 'unconfigured', source: 'OANDA API', environment: this.environment };
    }

    try {
      await this.getAccountSummary();
      return { status: 'healthy', source: 'OANDA API', environment: this.environment };
    } catch (error) {
      logger.error('OANDA API health check failed:', error.message);
      return { status: 'unhealthy', error: error.message };
    }
  }

  isConfigured() {
    return !!(this.accountId && this.accessToken);
  }

  canExecuteOrders() {
    return this.isConfigured() && this.tradingEnabled &&
      (this.environment === 'practice' || this.liveTradingAcknowledged);
  }

  assertConfigured() {
    if (!this.isConfigured()) {
      throw new Error('OANDA account ID and access token are required');
    }
  }
}

module.exports = OANDAAPI;