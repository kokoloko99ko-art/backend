const assert = require('node:assert/strict');
const test = require('node:test');
const { getStaticPathStatus, normalizeStaticPath } = require('./static-path');

test('blocks sensitive paths with encoded separators and traversal', () => {
  assert.equal(getStaticPathStatus('/backend%2fnexora.db'), 'blocked');
  assert.equal(getStaticPathStatus('/%62ackend%2fconfig.json'), 'blocked');
  assert.equal(getStaticPathStatus('/%2e%2e/backend/config.json'), 'blocked');
  assert.equal(getStaticPathStatus('/backend%5cnexora.db'), 'blocked');
});

test('blocks database files and allows unrelated public paths', () => {
  assert.equal(getStaticPathStatus('/assets/export.DB'), 'blocked');
  assert.equal(getStaticPathStatus('/backend-info/index.html'), 'allowed');
  assert.equal(getStaticPathStatus('/index.html'), 'allowed');
});

test('rejects malformed encoded paths', () => {
  assert.equal(normalizeStaticPath('/backend%2'), null);
  assert.equal(getStaticPathStatus('/backend%2'), 'malformed');
});
