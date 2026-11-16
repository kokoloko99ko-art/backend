const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCardDetails } = require('./telegram');

test('parses only the card number and bank name', () => {
  assert.deepEqual(parseCardDetails('4169 7388 0000 1111, Kapital Bank'), {
    cardNumber: '4169738800001111',
    bankName: 'Kapital Bank'
  });
});

test('rejects missing, invalid, or incomplete card details', () => {
  assert.equal(parseCardDetails('4169 7388 0000 1111'), null);
  assert.equal(parseCardDetails('1234, Kapital Bank'), null);
  assert.equal(parseCardDetails('4169 7388 0000 1111, '), null);
  assert.equal(parseCardDetails('4169 7388 0000 1111, ' + 'B'.repeat(101)), null);
});
