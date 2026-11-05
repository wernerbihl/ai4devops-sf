import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateRecipe } from '../../src/recipes/validate.ts';
import { validTask } from '../fixtures/contracts.ts';
async function catalog() { const m = await import('../../src/owners/toolkits.ts').catch(() => undefined); assert.ok(m?.nativeToolAllowlist, 'versioned explicit native tool catalog required'); return m; }
test('native toolkit catalog resolves exact versions and grants no implicit native tools', async () => {
    const m = await catalog();
    const task = validTask();
    task.required.tools = [];
    task.tools = [];
    assert.deepEqual(m.nativeToolAllowlist(task), ['custom:sf_factory_operation']);
    assert.equal(m.resolveNativeToolReference('tool', 'native-files', '1'), true);
    for (const [kind, id, version] of [['skill', 'native-files', '1'], ['tool', 'native-files', '3'], ['tool', 'builtin:view', '1']])
        assert.equal(m.resolveNativeToolReference(kind as any, id!, version!), false);
    task.tools = task.required.tools = ['native-files'];
    task.required.paths = [{ root: '.', mode: 'read' }];
    assert.deepEqual(m.nativeToolAllowlist(task), ['builtin:glob', 'builtin:grep', 'builtin:rg', 'builtin:view', 'custom:sf_factory_operation']);
    task.required.paths[0]!.mode = 'write';
    assert.ok(m.nativeToolAllowlist(task).includes('builtin:apply_patch'));
    task.tools = task.required.tools = ['native-terminal'];
    assert.ok(m.nativeToolAllowlist(task).includes('builtin:bash'));
    for (const id of ['builtin:view', 'mcp:*', 'new-tool']) {
        task.tools = task.required.tools = [id];
        assert.throws(() => m.nativeToolAllowlist(task));
    }
});
test('all code changing starters explicitly pin requested native tools without changing old receipts', async () => {
    const m = await catalog();
    for (const name of ['focused-feature', 'focused-bug-fix', 'scoped-quality']) {
        const v = validateRecipe(await readFile(new URL(`../../recipes/starter/${name}.yaml`, import.meta.url), 'utf8'), []);
        const sf = v.contract.variables.sf;
        assert.deepEqual(sf.taskTemplate.tools, ['native-files', 'native-terminal']);
        assert.deepEqual(sf.required.tools, sf.taskTemplate.tools);
        assert.deepEqual(v.toolVersions, { 'native-files': '2', 'native-terminal': '2' });
        for (const [id, version] of Object.entries(v.toolVersions))
            assert.equal(m.resolveNativeToolReference('tool', id, version), true);
    }
});

test('isolated worker version two is independently resolvable while legacy revision stays unchanged', async () => {
  const m=await catalog();
  assert.equal(m.resolveNativeToolReference('tool','native-files','2'),true);
  assert.equal(m.resolveNativeToolReference('tool','native-terminal','2'),true);
  assert.equal(m.resolveNativeToolReference('tool','native-files','1'),true);
  assert.equal(m.resolveNativeToolReference('tool','native-files','3'),false);
});
