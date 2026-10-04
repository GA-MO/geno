import { describe, expect, it } from 'vitest';
import { claudeEnv } from '../src/eval-claude.js';

describe('claudeEnv', () => {
  it('points every Claude Code model slot at the model, uses the Model Studio key as the auth token, and drops other secrets', () => {
    const env = claudeEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        DASHSCOPE_BASE_URL: 'https://ws.example.com/apps/anthropic',
        DASHSCOPE_API_KEY: 'sk-ms',
        OPENROUTER_API_KEY: 'sk-or',
        ANTHROPIC_API_KEY: 'sk-ant',
      },
      'qwen3.8-flash',
      { home: '/tmp/t/home', config: '/tmp/t/claude-config', tmp: '/tmp/t/claude-tmp' },
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/t/home',
      CLAUDE_CONFIG_DIR: '/tmp/t/claude-config',
      CLAUDE_CODE_TMPDIR: '/tmp/t/claude-tmp',
      ANTHROPIC_BASE_URL: 'https://ws.example.com/apps/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-ms',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'qwen3.8-flash',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3.8-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.8-flash',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.8-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.8-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    });
  });
});
