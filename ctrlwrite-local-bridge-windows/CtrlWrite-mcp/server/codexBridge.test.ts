import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexInvocation, lastCodexMessage } from './codexBridge';
import { validateAIConfig } from '../services/aiProviders';

test('extracts the final Codex agent message from JSONL output', () => {
    const output = [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First' } }),
        'not json',
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'ignored' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '  Final answer  ' } })
    ].join('\n');
    assert.equal(lastCodexMessage(output), 'Final answer');
});

test('Codex text configuration does not require API key or model', () => {
    assert.equal(validateAIConfig({ provider: 'codex', apiKey: '', model: '' }), null);
    assert.equal(validateAIConfig({ provider: 'openai', apiKey: '', model: 'gpt-4o' }), 'Enter an API key.');
});

test('Codex inherits local configuration and keeps model overrides optional', () => {
    const defaults = codexInvocation('');
    assert.equal(defaults.args.includes('--ignore-user-config'), false);
    assert.equal(defaults.args.includes('--model'), false);
    assert.equal(defaults.args[defaults.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(defaults.args.at(-1), '-');
    const override = codexInvocation('configured-model');
    assert.equal(override.args[override.args.indexOf('--model') + 1], 'configured-model');
});

test('Codex uses the Windows user directory when HOME is missing', () => {
    const environment = { USERPROFILE: 'windows-user-home', CODEX_HOME: 'custom-codex-home', PATH: 'cli-path' };
    const { env } = codexInvocation('', environment);
    assert.equal(env.HOME, environment.USERPROFILE);
    assert.equal(env.CODEX_HOME, environment.CODEX_HOME);
    assert.equal(env.PATH, environment.PATH);
    assert.equal(Object.hasOwn(environment, 'HOME'), false);
});

test('Codex preserves an explicitly configured home directory', () => {
    const { env } = codexInvocation('', { HOME: '/custom/home', USERPROFILE: 'windows-user-home' });
    assert.equal(env.HOME, '/custom/home');
});
