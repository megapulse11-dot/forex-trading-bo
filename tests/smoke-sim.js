"use strict";
const { SimulationEngine } = require('../src/trading/SimulationEngine');

const engine = new SimulationEngine();
console.log('EUR_USD quote:', JSON.stringify(engine.getQuote('EUR_USD')));

const order = engine.placeOrder({
  instrument: 'EUR_USD',
  side: 'BUY',
  units: 100,
  stopLoss: 1.05,
  takeProfit: 1.15,
  confirmation: 'PLACE SIMULATED ORDER',
  clientRequestId: 'req-1'
});
console.log('order:', JSON.stringify(order));
console.log('account:', JSON.stringify(engine.getAccount()));

for (let i = 0; i < 5; i += 1) engine.tick();
engine.markToMarket();
console.log('positions:', JSON.stringify(engine.getPositions()));
console.log('journal:', JSON.stringify(engine.getJournal()));

try {
  engine.placeOrder({ instrument: 'EUR_USD', side: 'BUY', units: 100, stopLoss: 1.05, takeProfit: 1.15 });
} catch (error) {
  console.log('missing confirmation ->', error.statusCode, error.message);
}
