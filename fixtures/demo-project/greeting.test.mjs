import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from './greeting.mjs';
test('greets a person', () => assert.equal(greeting('Ada'), 'Hello, Ada!'));
