import test from 'node:test';
import assert from 'node:assert/strict';
import { redactMongoUrl } from '../utils/redact.js';

test('removes the password from an Atlas connection string', () => {
  const redacted = redactMongoUrl(
    'mongodb+srv://zen:Sup3rSecret@cluster0.ab1cd.mongodb.net/flowboard?retryWrites=true'
  );
  assert.equal(redacted, 'mongodb+srv://zen:***@cluster0.ab1cd.mongodb.net/flowboard?retryWrites=true');
});

test('never leaves any part of the password behind', () => {
  const redacted = redactMongoUrl('mongodb+srv://zen:p4ssw0rd-guess@cluster0.ab1cd.mongodb.net/flowboard');
  assert.ok(!redacted.includes('p4ssw0rd'));
  assert.ok(!redacted.includes('guess'));
});

test('keeps the username, host, database and query string, which are what make the line useful', () => {
  const redacted = redactMongoUrl('mongodb+srv://zen:hunter2@cluster0.ab1cd.mongodb.net/flowboard?w=majority');
  assert.ok(redacted.includes('zen'));
  assert.ok(redacted.includes('cluster0.ab1cd.mongodb.net'));
  assert.ok(redacted.includes('flowboard'));
  assert.ok(redacted.includes('w=majority'));
});

test('handles a password containing an unencoded @', () => {
  const redacted = redactMongoUrl('mongodb+srv://zen:pa@ss@cluster0.ab1cd.mongodb.net/flowboard');
  assert.equal(redacted, 'mongodb+srv://zen:***@cluster0.ab1cd.mongodb.net/flowboard');
  assert.ok(!redacted.includes('ss@'));
});

test('leaves a credential-free local URL untouched', () => {
  assert.equal(redactMongoUrl('mongodb://127.0.0.1:27017/flowboard'), 'mongodb://127.0.0.1:27017/flowboard');
});

test('leaves non-URL input untouched rather than mangling it', () => {
  assert.equal(redactMongoUrl(''), '');
  assert.equal(redactMongoUrl(undefined), '');
  assert.equal(redactMongoUrl('not-a-url'), 'not-a-url');
});
