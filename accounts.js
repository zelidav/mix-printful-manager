require('dotenv').config();

// MiX = a multi-store manager. Each STORE is a separate Printful account with its OWN PAT.
// The UI shows a "Store" picker; selecting one routes every call through that store's token.
//
// To add a store: create a new PAT, drop it in .env (e.g. PAT_NEWSTORE=...), and append an entry here.
//   id    — short slug used by the UI/header
//   name  — label shown in the Store picker
//   token — that store's Printful Personal Access Token (from .env, never hard-coded)
const ACCOUNTS = [
  { id: 'daves', name: 'Made in Xiaolin - Daves Dispensary', token: process.env.PAT_DAVES },
  // { id: 'store2', name: 'Made in Xiaolin - <Store>', token: process.env.PAT_STORE2 },
].filter(a => a.token);

function getAccount(id) {
  return ACCOUNTS.find(a => a.id === id) || ACCOUNTS[0];
}
// Browser-safe list (never expose tokens)
function publicList() {
  return ACCOUNTS.map(a => ({ id: a.id, name: a.name }));
}

module.exports = { ACCOUNTS, getAccount, publicList };
