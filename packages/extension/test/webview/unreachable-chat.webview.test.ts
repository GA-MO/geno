import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { unreachableNotice } from '../../src/runtime.js';
import { closeBrowser, openPanel } from './harness.js';
import { turnStart } from './turns.js';

afterAll(closeBrowser);

describe('a chat whose provider has no key here', () => {
  it('says why the turn failed, and its New chat and Set key buttons ask the extension for each', async () => {
    const panel = await openPanel({ width: 300 });
    const notice = unreachableNotice({ reason: 'no-credentials', provider: 'modelstudio', model: 'qwen3.8-flash', field: 'apiKey' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    await panel.host.act(turnStart('t1', 'Fix the test'), { type: 'error', ...notice }, { type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });
    await panel.frame();

    expect(await panel.eval<string>(`doc.querySelector('.turn-error[role="alert"]').textContent`)).toBe(
      'This chat ran on Model Studio · qwen3.8-flash, and Geno has no Model Studio key. Start a new chat to use Anthropic · claude-sonnet-5-5, or set the Model Studio key.New chatSet key',
    );
    expect(await panel.page.evaluate(overflowing as () => string[]), 'nothing runs past the panel at 300px').toEqual([]);
    await panel.screenshot('unreachable-chat');

    await panel.click('.turn-error button', 'New chat');
    expect(await panel.host.next('error-fix')).toEqual({ type: 'error-fix', fix: { label: 'New chat', fix: 'new-chat' } });
    await panel.click('.turn-error button', 'Set key');
    expect(await panel.host.next('error-fix')).toEqual({ type: 'error-fix', fix: { label: 'Set key', fix: 'set-key', provider: 'modelstudio', field: 'apiKey' } });
    await panel.close();
  });

  it('shows any other failure as its message, with no buttons', async () => {
    const panel = await openPanel();
    await panel.host.act(turnStart('t1', 'Fix the test'), { type: 'error', message: 'the disk is full' }, { type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });
    await panel.frame();
    expect(await panel.eval<string>(`doc.querySelector('.turn-error').textContent`)).toBe('The disk is full');
    expect(await panel.count('.turn-error button')).toBe(0);
    await panel.close();
  });
});
