"use strict";

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const logger = require('winston');
const path = require('path');
const OANDAAPI = require('./api/OANDAAPI');
const { OrderService } = require('./trading/OrderService');
const { SimulationEngine, CONFIRMATION_PHRASE: SIMULATION_CONFIRMATION } = require('./trading/SimulationEngine');

// Load environment variables
dotenv.config();

// Configure logging
logger.configure({
  level: process.env.LOG_LEVEL || 'info',
  format: logger.format.combine(
    logger.format.timestamp(),
    logger.format.errors({ stack: true }),
    logger.format.json()
  ),
  defaultMeta: { service: 'forex-trading-bot' },
  transports: [
    new logger.transports.Console({
      stderr: true,
      format: logger.format.combine(
        logger.format.colorize(),
        logger.format.simple()
      )
    }),
    new logger.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new logger.transports.File({ filename: 'logs/combined.log' })
  ]
});

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_URL || '').split(',').map(origin => origin.trim()).filter(Boolean);
const io = socketIO(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com']
    }
  }
}));
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Initialize API integrations
const FrankfurterAPI = require('./api/FrankfurterAPI');

// API instances
const frankfurterAPI = new FrankfurterAPI();

// Initialize trading strategies
const SMAStrategy = require('./strategies/SMAStrategy');
const BollingerBandsStrategy = require('./strategies/BollingerBandsStrategy');
const MomentumStrategy = require('./strategies/MomentumStrategy');

// Initialize risk management
const RiskManager = require('./risk/RiskManager');
const oandaAPI = new OANDAAPI();
const orderService = new OrderService(oandaAPI);

// Local execution venue used whenever no broker account is connected, so the
// desk is functional rather than read-only. Quotes are anchored to real ECB
// reference rates; nothing here can reach a broker.
const simulation = new SimulationEngine({
  rateProvider: frankfurterAPI,
  initialBalance: Number(process.env.SIM_INITIAL_BALANCE) > 0 ? Number(process.env.SIM_INITIAL_BALANCE) : 10000,
  tickIntervalMs: Number(process.env.SIM_TICK_MS) > 0 ? Number(process.env.SIM_TICK_MS) : 1500
});

// Initialize portfolio
const Portfolio = require('./portfolio/Portfolio');

// Initialize backtesting
const Backtester = require('./backtest/Backtester');

// Global instances
const riskManager = new RiskManager();
const portfolio = new Portfolio();
const backtester = new Backtester();

// WebSocket connections tracking
const connectedSockets = new Map();

// API Routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/currencies', async (_req, res) => {
  try {
    const currencies = await frankfurterAPI.getCurrencies();
    res.json(currencies);
  } catch (error) {
    logger.error('Error fetching currencies:', error);
    res.status(500).json({ error: 'Failed to fetch currencies' });
  }
});

app.get('/api/rates/latest', async (req, res) => {
  try {
    const { base = 'EUR', symbols } = req.query;
    const rates = await frankfurterAPI.getLatestRates(base, symbols);
    res.json(rates);
  } catch (error) {
    logger.error('Error fetching latest rates:', error);
    res.status(500).json({ error: 'Failed to fetch latest rates' });
  }
});

app.get('/api/rates/historical', async (req, res) => {
  try {
    const { base, symbols, start_date, end_date } = req.query;
    if (!base || !symbols || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    const rates = await frankfurterAPI.getHistoricalRates(base, symbols, start_date, end_date);
    res.json(rates);
  } catch (error) {
    logger.error('Error fetching historical rates:', error);
    res.status(500).json({ error: 'Failed to fetch historical rates' });
  }
});

app.use('/vendor/lightweight-charts', express.static(path.join(__dirname, '../node_modules/lightweight-charts/dist')));
app.use(express.static(path.join(__dirname, '../public')));

// Trading endpoints
app.post('/api/strategies/:name/backtest', async (req, res) => {
  try {
    const { name } = req.params;
    const { symbol, start_date, end_date, timeframe, initial_balance } = req.body;
    
    if (!symbol || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const strategy = getStrategyByName(name);
    const results = await backtester.runBacktest(strategy, symbol, start_date, end_date, timeframe, initial_balance);
    res.json(results);
  } catch (error) {
    logger.error('Error running backtest:', error);
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

app.post('/api/strategies/:name/paper-trade', async (req, res) => {
  try {
    const { name } = req.params;
    const { symbol, initial_balance, position_size, stop_loss, take_profit } = req.body;

    const balance = initial_balance === undefined ? portfolio.getSummary().equity : Number(initial_balance);
    if (!symbol || !Number.isFinite(balance) || balance <= 0) {
      return res.status(400).json({ error: 'A symbol and positive initial_balance are required' });
    }

    const strategy = getStrategyByName(name);
    const position = await strategy.execute(portfolio, symbol, balance, position_size, stop_loss, take_profit);
    if (!position) {
      return res.json({ status: 'NO_TRADE', symbol, strategy: name });
    }

    portfolio.addPosition(position);
    
    logger.info(`Paper trade executed: ${position.symbol} - ${position.side} ${position.size} units`);
    return res.json(position);
  } catch (error) {
    logger.error('Error executing paper trade:', error);
    res.status(500).json({ error: 'Failed to execute paper trade' });
  }
});

// Portfolio endpoints
app.get('/api/portfolio', (_req, res) => {
  res.json(portfolio.getSummary());
});

app.get('/api/portfolio/positions', (_req, res) => {
  res.json(portfolio.getPositions());
});

app.get('/api/portfolio/performance', (_req, res) => {
  res.json(portfolio.getPerformanceData());
});

// Risk management endpoints
app.get('/api/risk/assessment', (_req, res) => {
  res.json(riskManager.getRiskAssessment());
});

app.post('/api/risk/stop-loss', async (req, res) => {
  try {
    const { position_id, stop_loss_price } = req.body;
    await riskManager.setStopLoss(position_id, stop_loss_price);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error setting stop loss:', error);
    res.status(500).json({ error: 'Failed to set stop loss' });
  }
});

app.get('/api/live/status', (_req, res) => {
  const uncertainOrders = orderService.hasUncertainOrders();
  const brokerConnected = oandaAPI.isConfigured();
  const executionBlockReason = uncertainOrders
    ? 'Order submission is halted because a previous broker response was uncertain. Review OANDA activity before clearing the local order journal.'
    : !oandaAPI.canExecuteOrders()
      ? 'Order execution is not armed by server configuration.'
      : null;
  res.json({
    mode: brokerConnected ? 'BROKER' : 'SIMULATION',
    broker: 'OANDA',
    environment: oandaAPI.environment,
    accountConfigured: brokerConnected,
    executionAvailable: oandaAPI.canExecuteOrders() && !uncertainOrders,
    confirmationPhrase: brokerConnected
      ? (oandaAPI.environment === 'live' ? 'PLACE LIVE ORDER' : 'PLACE PRACTICE ORDER')
      : SIMULATION_CONFIRMATION,
    orderReconciliationRequired: uncertainOrders,
    executionBlockReason,
    maximumOrderUnits: 1000,
    maximumRiskPercent: 1,
    marketData: brokerConnected ? 'OANDA account pricing' : 'ECB reference rates with simulated ticks'
  });
});

app.get('/api/live/orders/recent', (_req, res) => {
  res.json({ orders: orderService.listRecentOrders() });
});

app.get('/api/live/account', async (_req, res) => {
  try {
    const account = await oandaAPI.getAccountSummary();
    res.json({
      id: account.id,
      alias: account.alias,
      currency: account.currency,
      balance: account.balance,
      NAV: account.NAV,
      unrealizedPL: account.unrealizedPL,
      marginUsed: account.marginUsed,
      marginAvailable: account.marginAvailable,
      openTradeCount: account.openTradeCount,
      pendingOrderCount: account.pendingOrderCount
    });
  } catch (error) {
    logger.error('Error fetching OANDA account summary:', error.message);
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/live/positions', async (_req, res) => {
  try {
    const account = await oandaAPI.getPositions();
    res.json({ positions: account.positions || [] });
  } catch (error) {
    logger.error('Error fetching OANDA open positions:', error.message);
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/live/pricing', async (req, res) => {
  try {
    const instruments = String(req.query.instruments || '').split(',').filter(Boolean);
    if (!instruments.length || instruments.length > 8 ||
        instruments.some(instrument => !/^[A-Z]{3}_[A-Z]{3}$/.test(instrument))) {
      return res.status(400).json({ error: 'Provide 1 to 8 valid OANDA instrument names' });
    }
    const response = await oandaAPI.getPricing(instruments);
    res.json({
      prices: (response.prices || []).map(price => ({
        instrument: price.instrument,
        status: price.status,
        time: price.time,
        bids: price.bids,
        asks: price.asks
      }))
    });
  } catch (error) {
    logger.error('Error fetching OANDA prices:', error.message);
    res.status(503).json({ error: error.message });
  }
});

app.post('/api/live/orders', async (req, res) => {
  try {
    const order = await orderService.placeOrder(req.body);
    logger.warn(`Manually confirmed OANDA ${oandaAPI.environment} order: ${order.side} ${order.units} ${order.instrument}`);
    return res.status(201).json(order);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    logger.error('OANDA order request rejected:', error.message);
    return res.status(statusCode).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Simulation venue: the desk stays fully functional with no broker credentials.
// ---------------------------------------------------------------------------

function simulationPayload(closedTrades = []) {
  return {
    account: simulation.getAccount(),
    positions: simulation.getPositions(),
    quotes: simulation.getQuotes(),
    orders: simulation.getJournal(50),
    closed: closedTrades
  };
}

function broadcastSimulation(closedTrades = []) {
  if (!connectedSockets.size) return;
  const payload = simulationPayload(closedTrades);
  connectedSockets.forEach(socket => socket.emit('sim:update', payload));
}

app.get('/api/sim/status', (_req, res) => {
  res.json({
    mode: 'SIMULATION',
    venue: 'Local simulation',
    anchorSource: simulation.anchorSource,
    instruments: simulation.instruments,
    tickIntervalMs: simulation.tickIntervalMs,
    confirmationPhrase: SIMULATION_CONFIRMATION,
    maximumOrderUnits: 1000,
    maximumRiskPercent: 1,
    account: simulation.getAccount(),
    positions: simulation.getPositions(),
    orders: simulation.getJournal(50),
    quotes: simulation.getQuotes(),
    disclaimer: 'Simulated venue. Orders are filled locally and never leave this process.'
  });
});

app.get('/api/sim/quotes', (_req, res) => {
  res.json({ quotes: simulation.getQuotes(), anchorSource: simulation.anchorSource });
});

app.get('/api/sim/account', (_req, res) => {
  res.json(simulation.getAccount());
});

app.get('/api/sim/positions', (_req, res) => {
  res.json({ positions: simulation.getPositions() });
});

app.get('/api/sim/orders', (_req, res) => {
  res.json({ orders: simulation.getJournal(50) });
});

app.post('/api/sim/orders', (req, res) => {
  try {
    const order = simulation.placeOrder(req.body);
    logger.info(`Simulated order filled: ${order.side} ${order.units} ${order.instrument} @ ${order.price}`);
    broadcastSimulation();
    return res.status(201).json(order);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
    logger.warn('Simulated order rejected:', error.message);
    return res.status(statusCode).json({ error: error.message });
  }
});

app.post('/api/sim/positions/:id/close', (req, res) => {
  try {
    const result = simulation.closePositionById(req.params.id);
    logger.info(`Simulated position closed: ${result.instrument} @ ${result.exitPrice} (${result.reason})`);
    broadcastSimulation();
    return res.json(result);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
    return res.status(statusCode).json({ error: error.message });
  }
});

app.post('/api/sim/reset', (_req, res) => {
  const account = simulation.reset();
  logger.info('Simulation reset to starting balance');
  broadcastSimulation();
  res.json(account);
});


// WebSocket connections
io.on('connection', (socket) => {
  logger.info('New WebSocket connection:', socket.id);
  connectedSockets.set(socket.id, socket);
  socket.emit('sim:update', simulationPayload());
  
  socket.on('join-currency', (currency) => {
    socket.join(`currency_${currency}`);
    logger.info(`Socket ${socket.id} joined currency ${currency}`);
  });
  
  socket.on('disconnect', () => {
    logger.info('WebSocket disconnected:', socket.id);
    connectedSockets.delete(socket.id);
  });
});

// Broadcast real-time data
async function broadcastRealTimeData() {
  try {
    const latestRates = await frankfurterAPI.getLatestRates('EUR', 'USD,GBP,JPY,AUD,CAD,CHF');
    
    connectedSockets.forEach((socket) => {
      socket.emit('rates_update', latestRates);
    });
    
    // Broadcast portfolio updates
    connectedSockets.forEach((socket) => {
      socket.emit('portfolio_update', portfolio.getSummary());
    });
  } catch (error) {
    logger.error('Error broadcasting real-time data:', error);
  }
}

// Schedule real-time data updates
setInterval(broadcastRealTimeData, 5000);

// Drive the simulation: tick first so every broadcast carries fresh prices and
// any stop/target fills that the tick produced.
const simulationTimer = setInterval(() => {
  const closed = simulation.tick();
  if (closed.length) logger.info(`Simulated exits: ${closed.map(trade => `${trade.instrument} ${trade.reason}`).join(', ')}`);
  broadcastSimulation(closed);
}, simulation.tickIntervalMs);
if (typeof simulationTimer.unref === 'function') simulationTimer.unref();

Promise.resolve(simulation.refreshAnchors())
  .then(() => logger.info(`Simulation anchored to ${simulation.anchorSource} reference rates`))
  .catch(() => undefined);

// Strategy helper functions
function getStrategyByName(name) {
  const strategies = {
    'SMA': new SMAStrategy(),
    'BollingerBands': new BollingerBandsStrategy(),
    'Momentum': new MomentumStrategy()
  };
  
  if (!strategies[name]) {
    throw new Error(`Strategy ${name} not found`);
  }
  
  return strategies[name];
}

// Error handling middleware
app.use((err, _req, res, _next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  logger.info(`Forex Trading Bot server running at http://${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = app;