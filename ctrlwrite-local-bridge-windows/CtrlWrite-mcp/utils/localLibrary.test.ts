import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { skillFromLocalZip } from './localLibrary';

test('local skill import reads only SKILL.md', () => {
    const zip = zipSync({ 'example/SKILL.md': strToU8('name: Example\nUse this skill.'), 'example/script.js': strToU8('do not run') });
    assert.deepEqual(skillFromLocalZip(zip), { name: 'Example', content: 'name: Example\nUse this skill.' });
    assert.throws(() => skillFromLocalZip(zipSync({ 'one/SKILL.md': strToU8('first'), 'two/SKILL.md': strToU8('second') })), /每次只能/);
});
