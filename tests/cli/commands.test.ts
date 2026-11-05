import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS, parseCommand } from '../../src/cli/main.ts';

test('only the three public commands are accepted and help is a flag', () => {
  assert.deepEqual(PUBLIC_COMMANDS, ['setup', 'next', 'uninstall']);
  assert.deepEqual(parseCommand(['setup', '--help']), { command: 'setup', help: true });
  assert.deepEqual(parseCommand(['--help']), { command: undefined, help: true });
  assert.throws(() => parseCommand(['daemon']));
  assert.throws(() => parseCommand(['setup', 'next']));
  assert.throws(() => parseCommand(['help']));
});
