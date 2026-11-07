import assert from 'node:assert/strict';
import test from 'node:test';
import { focusSearchQuery } from './search-query';

test('a greeting becomes the product words without a rephrased ending', () => {
  assert.equal(focusSearchQuery('Այո, բարև ձեզ, ինձ կծանոթացնեք կոսմո փաթեթներին։'), 'կոսմո փաթեթներ');
  assert.equal(focusSearchQuery('կոսմո փաթեթներ'), 'կոսմո փաթեթներ');
});

test('price and internet limits stay in the caller’s words', () => {
  assert.equal(focusSearchQuery('Tell me about Cosmo packages under 10000 dram'), 'cosmo packages under 10000 dram');
  assert.equal(focusSearchQuery('կոսմո փաթեթ մինչև 10000 դրամով'), 'կոսմո փաթեթ մինչև 10000 դրամ');
});

test('a greeting alone is left unchanged', () => {
  assert.equal(focusSearchQuery('բարև'), 'բարև');
  assert.equal(focusSearchQuery('  Այո, բարև ձեզ, ինձ կծանոթացնեք կոսմո փաթեթներին։  '), focusSearchQuery('Այո, բարև ձեզ, ինձ կծանոթացնեք կոսմո փաթեթներին։'));
});
