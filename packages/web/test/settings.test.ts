import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../../extension/package.json' with { type: 'json' };
import { affects, configurationOf, defaultsOf, SettingsFile } from '../src/settings.js';

const fresh = async () => path.join(await mkdtemp(path.join(tmpdir(), 'gcode-web-settings-')), 'web-settings.json');

async function open(file: string) {
  const changes: string[][] = [];
  const settings = await SettingsFile.open(file, defaultsOf(manifest), (keys) => changes.push([...keys]));
  return { settings, changes };
}

describe('the settings file', () => {
  it('answers with the manifest’s defaults before anything is set', async () => {
    const { settings } = await open(await fresh());
    const gcode = configurationOf(settings, 'gcode');
    expect(gcode.get('approvalMode')).toBe('ask');
    expect(gcode.get('ui.style')).toBe(manifest.contributes.configuration.properties['gcode.ui.style'].default);
    expect(configurationOf(settings).get('gcode.approvalMode')).toBe('ask');
    expect(gcode.get('not.a.setting', 7)).toBe(7);
    expect(gcode.inspect('approvalMode')).toEqual({ key: 'gcode.approvalMode', defaultValue: 'ask', globalValue: undefined });
  });

  it('writes an update to the file as settings.json keys it, and says which key changed', async () => {
    const file = await fresh();
    const { settings, changes } = await open(file);
    await configurationOf(settings, 'gcode').update('approvalMode', 'auto');
    await configurationOf(settings, 'gcode').update('roles', { explore: { provider: 'openrouter' } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'gcode.approvalMode': 'auto', 'gcode.roles': { explore: { provider: 'openrouter' } } });
    expect(changes).toEqual([['gcode.approvalMode'], ['gcode.roles']]);
    const reopened = configurationOf((await open(file)).settings, 'gcode');
    expect(reopened.get('approvalMode')).toBe('auto');
    expect(reopened.inspect('roles')?.globalValue).toEqual({ explore: { provider: 'openrouter' } });
  });

  it('drops a key updated to undefined, so the default shows again', async () => {
    const file = await fresh();
    const { settings } = await open(file);
    await configurationOf(settings, 'gcode').update('approvalMode', 'auto');
    await configurationOf(settings, 'gcode').update('approvalMode', undefined);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
    expect(configurationOf(settings, 'gcode').get('approvalMode')).toBe('ask');
  });

  it('refuses a file that is not a JSON object rather than overwrite it', async () => {
    const file = await fresh();
    await writeFile(file, '{ "gcode.model": ');
    await expect(open(file)).rejects.toThrow(/not valid JSON/);
    await writeFile(file, '[]');
    await expect(open(file)).rejects.toThrow(/JSON object/);
  });
});

describe('affects', () => {
  it('matches a section, its parents and its children, as affectsConfiguration does', () => {
    expect(affects(['gcode.ui.style'], 'gcode')).toBe(true);
    expect(affects(['gcode.ui.style'], 'gcode.ui.style')).toBe(true);
    expect(affects(['gcode.roles'], 'gcode.roles.explore')).toBe(true);
    expect(affects(['gcode.ui.style'], 'gcode.ui.showChanges')).toBe(false);
    expect(affects(['gcode.model'], 'gcode.modelPath')).toBe(false);
  });
});
