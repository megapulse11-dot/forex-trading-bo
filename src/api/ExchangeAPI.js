"use strict";

const axios = require('axios');
const logger = require('winston');

class ExchangeAPI {
  constructor() {
    this.baseURL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1';
    this.cache = new Map();
    this.cacheTimeout = 120000; // 2 minutes
  }

  async getLatestRates(base = 'EUR', symbols = null) {
    const cacheKey = `exchange_latest_${base}_${symbols}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseURL}/currencies/${base}.min.json`;
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ForexTradingBot/1.0'
        }
      });

      const currencies = response.data;
      const rates = {};
      
      if (symbols) {
        const symbolArray = symbols.split(',');
        symbolArray.forEach(symbol => {
          if (currencies[symbol]) {
            rates[symbol] = currencies[symbol];
          }
        });
      }

      const result = {
        amount: 1,
        base: base,
        rates: rates,
        timestamp: new Date().toISOString()
      };

      this.setCache(cacheKey, result);
      logger.info(`Fetched latest rates from Exchange API: ${base}`);
      return result;
    } catch (error) {
      logger.error('Error fetching latest rates from Exchange API:', error.message);
      throw new Error('Failed to fetch latest rates from Exchange API');
    }
  }

  async getHistoricalRates(base, symbols, start_date, end_date) {
    const cacheKey = `exchange_historical_${base}_${symbols}_${start_date}_${end_date}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    // Exchange API doesn't provide historical data, return latest rates as fallback
    logger.warn('Exchange API does not support historical data, returning latest rates as fallback');
    return this.getLatestRates(base, symbols);
  }

  async getCurrencies() {
    const cacheKey = 'exchange_currencies';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseURL}/currencies.json`;
    
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
      logger.info('Fetched currencies list from Exchange API');
      return result;
    } catch (error) {
      logger.error('Error fetching currencies from Exchange API:', error.message);
      throw new Error('Failed to fetch currencies from Exchange API');
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
    if (this.cache.size > 50) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  async getExchangeRate(base, target, date = null) {
    const cacheKey = `exchange_${base}_${target}_${date}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseURL}/currencies/${base}.min.json`;
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ForexTradingBot/1.0'
        }
      });

      const rate = response.data[target] || 0;
      this.setCache(cacheKey, rate);
      return rate;
    } catch (error) {
      logger.error(`Error fetching exchange rate ${base}/${target} from Exchange API:`, error.message);
      throw new Error('Failed to fetch exchange rate from Exchange API');
    }
  }

  async healthCheck() {
    try {
      await axios.get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies.json', {
        timeout: 5000
      });
      return { status: 'healthy', source: 'Exchange API' };
    } catch (error) {
      logger.error('Exchange API health check failed:', error.message);
      return { status: 'unhealthy', error: error.message };
    }
  }
}

module.exports = ExchangeAPI;