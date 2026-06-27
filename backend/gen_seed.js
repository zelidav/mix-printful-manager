require('dotenv').config();
const fs = require('fs');
const { computePrices } = require('./catalog');
const token = process.env.PAT_DAVES;
(async () => {
  console.log('computing catalog prices (throttled)…');
  const t = Date.now();
  const prices = await computePrices(token);
  fs.writeFileSync(__dirname + '/catalog-prices.seed.json', JSON.stringify(prices));
  console.log('seed written:', Object.keys(prices).length, 'products in', Math.round((Date.now()-t)/1000) + 's');
})();
