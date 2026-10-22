"use strict";

const axios = require('axios');
const logger = require('winston');

class FrankfurterAPI {
  constructor() {
    this.baseURL = 'https://api.frankfurter.dev/v1';
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute
  }

  async getLatestRates(base = 'EUR', symbols = null) {
    const cacheKey = `latest_${base}_${symbols}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const query = new URLSearchParams({ from: base });
    if (symbols) query.set('to', Array.isArray(symbols) ? symbols.join(',') : symbols);
    const url = `${this.baseURL}/latest?${query}`;
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ForexTradingBot/1.0'
        }
      });

      const result = {
        amount: response.data.amount,
        base: response.data.base,
        rates: response.data.rates,
        timestamp: new Date().toISOString()
      };

      this.setCache(cacheKey, result);
      logger.info(`Fetched latest rates: ${base} to ${symbols}`);
      return result;
    } catch (error) {
      logger.error('Error fetching latest rates from Frankfurter API:', error.message);
      throw new Error('Failed to fetch latest rates');
    }
  }

  async getHistoricalRates(base, symbols, start_date, end_date) {
    const cacheKey = `historical_${base}_${symbols}_${start_date}_${end_date}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const query = new URLSearchParams({ from: base, to: Array.isArray(symbols) ? symbols.join(',') : symbols });
    const url = `${this.baseURL}/${start_date}..${end_date}?${query}`;
    
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'ForexTradingBot/1.0'
        }
      });

      const result = {
        amount: response.data.amount,
        base: response.data.base,
        rates: response.data.rates,
        start_date: start_date,
        end_date: end_date,
        timestamp: new Date().toISOString()
      };

      this.setCache(cacheKey, result);
      logger.info(`Fetched historical rates: ${base} from ${start_date} to ${end_date}`);
      return result;
    } catch (error) {
      logger.error('Error fetching historical rates from Frankfurter API:', error.message);
      throw new Error('Failed to fetch historical rates');
    }
  }

  async getCurrencies() {
    const cacheKey = 'currencies';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseURL}/currencies`;
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ForexTradingBot/1.0'
        }
      });

      const result = {
        currencies: response.data,
        timestamp: new Date().toISOString()
      };

      this.setCache(cacheKey, result);
      logger.info('Fetched currencies list');
      return result;
    } catch (error) {
      logger.error('Error fetching currencies from Frankfurter API:', error.message);
      throw new Error('Failed to fetch currencies');
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
    if (this.cache.size > 100) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  async getExchangeRate(base, target, date = null) {
    const query = new URLSearchParams({ from: base, to: target });
    const url = `${this.baseURL}/${date || 'latest'}?${query}`;
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ForexTradingBot/1.0'
        }
      });

      return response.data.rates[target];
    } catch (error) {
      logger.error(`Error fetching exchange rate ${base}/${target} from Frankfurter API:`, error.message);
      throw new Error('Failed to fetch exchange rate');
    }
  }
}

module.exports = FrankfurterAPI;