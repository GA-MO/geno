import { useState, type ReactNode } from 'react';
import { codeSegments } from '../scenario/labels.js';
import type { Shown } from '../scenario/model.js';
import type { Long, More, PayloadView } from '../scenario/payload.js';

type Mock<K extends Shown['kind']> = Extract<Shown, { kind: K }>;

export const Code = ({ text }: { readonly text: string }): ReactNode =>
  codeSegments(text).map((segment, i) => (segment.code ? <code key={i}>{segment.text}</code> : <span key={i}>{segment.text}</span>));

const PERMISSION_OPTIONS = ['Allow', 'Deny', 'Always allow in this workspace', 'No, and tell the agent…'];

function Permission({ mock }: { readonly mock: Mock<'permission'> }) {
  const options = mock.options ?? PERMISSION_OPTIONS;
  return (
    <div className="mk-permission">
      <p className="mk-title">Run this command?</p>
      <pre className="mk-command">{mock.command}</pre>
      {mock.reason === undefined ? null : <p className="mk-muted">{mock.reason}</p>}
      {mock.rule === undefined ? null : (
        <p className="mk-muted">
          Always allow saves the rule <code>{mock.rule}</code> for this workspace. Settings lists its rules.
        </p>
      )}
      {mock.note === undefined ? null : <p className="mk-input">{mock.note}</p>}
      <p className="mk-buttons">
        {options.map((option, i) => (
          <span key={option} className={`mk-button${i === 0 ? ' primary' : ''}${option === mock.chosen ? ' chosen' : ''}`}>
            {option}
          </span>
        ))}
      </p>
    </div>
  );
}

function Question({ mock }: { readonly mock: Mock<'question'> }) {
  return (
    <div className="mk-permission">
      <p className="mk-title">{mock.question}</p>
      <p className="mk-choices">
        {mock.options.map((option) => (
          <span key={option} className={`mk-choice${option === mock.chosen ? ' chosen' : ''}`}>
            {option}
          </span>
        ))}
      </p>
    </div>
  );
}

const Actions = ({ actions }: { readonly actions: readonly string[] | undefined }) =>
  actions === undefined || actions.length === 0 ? null : (
    <p className="mk-buttons">
      {actions.map((action) => (
        <span key={action} className="mk-button">
          {action}
        </span>
      ))}
    </p>
  );

const STATUS_MARK: Readonly<Record<Mock<'step'>['status'], ReactNode>> = {
  running: <span className="mk-spin" aria-label="running" />,
  done: <span className="mk-ok" aria-label="done">✓</span>,
  failed: <span className="mk-bad" aria-label="failed">✕</span>,
  denied: <span className="mk-bad" aria-label="denied">✕</span>,
};

function Step({ mock }: { readonly mock: Mock<'step'> }) {
  return (
    <div className={`mk-step ${mock.status}`}>
      <p className="mk-step-row">
        {STATUS_MARK[mock.status]}
        <span className="mk-mono">{mock.label}</span>
      </p>
      {mock.output === undefined ? null : <pre className="mk-output">{mock.output}</pre>}
      {mock.note === undefined ? null : <p className="mk-note">{mock.note}</p>}
    </div>
  );
}

function Message({ mock }: { readonly mock: Mock<'message'> }) {
  return (
    <div className={`mk-message from-${mock.from}`}>
      <p>
        {mock.text}
        {mock.streaming === true ? <span className="mk-caret" aria-hidden="true" /> : null}
      </p>
      {mock.footer === undefined ? null : (
        <p className="mk-footer">
          {mock.footer.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </p>
      )}
    </div>
  );
}

const TASK_LABELS: Readonly<Record<Mock<'task'>['status'], string>> = { running: 'Running', 'needs-input': 'Needs input', done: 'Done', failed: 'Failed' };

function Task({ mock }: { readonly mock: Mock<'task'> }) {
  return (
    <div className={`mk-task ${mock.status}`}>
      {mock.status === 'running' ? <span className="mk-spin" aria-hidden="true" /> : <span className="mk-dot" aria-hidden="true" />}
      <span className="mk-task-title">{mock.title}</span>
      {mock.detail === undefined ? null : <span className="mk-muted">{mock.detail}</span>}
      <span className="mk-status">{TASK_LABELS[mock.status]}</span>
      {mock.actions?.map((action) => (
        <span key={action} className="mk-button">
          {action}
        </span>
      ))}
    </div>
  );
}

function Composer({ mock }: { readonly mock: Mock<'composer'> }) {
  return (
    <div className="mk-composer">
      {mock.header === undefined ? null : <p className="mk-muted">{mock.header}</p>}
      <p className="mk-composer-box">
        <span className={mock.text === undefined ? 'mk-placeholder' : undefined}>{mock.text ?? 'Ask Geno…'}</span>
        <span className={`mk-button ${mock.state === 'working' ? 'stop' : 'primary'}`}>{mock.state === 'working' ? 'Stop' : 'Send'}</span>
      </p>
    </div>
  );
}

const isLong = (value: unknown): value is Long => typeof value === 'object' && value !== null && '$long' in value;
const isMore = (value: unknown): value is More => typeof value === 'object' && value !== null && '$more' in value;
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;

function Json({ value, path, view, open, toggle, depth }: { readonly value: unknown; readonly path: string; readonly view: PayloadView; readonly open: ReadonlySet<string>; readonly toggle: (path: string) => void; readonly depth: number }): ReactNode {
  const marked = view.highlight.includes(path) ? ' mark' : '';
  if (isLong(value))
    return (
      <span className={`js-str${marked}`}>
        {JSON.stringify(value.$long).slice(0, -1)}
        <span className="js-cut">… {plural(value.chars, 'char')}</span>"
      </span>
    );
  if (isMore(value)) return <span className="js-cut">… {value.$more} more</span>;
  if (value === null || typeof value !== 'object') return <span className={`js-${value === null ? 'null' : typeof value}${marked}`}>{JSON.stringify(value)}</span>;
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
  const [start, end] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const folded = view.collapse.includes(path) && !open.has(path);
  if (entries.length === 0) return <span className={marked.trim()}>{start + end}</span>;
  if (folded)
    return (
      <button type="button" className="js-fold" onClick={() => toggle(path)}>
        {start} {Array.isArray(value) ? plural(value.length, 'item') : plural(entries.length, 'key')} {end}
      </button>
    );
  return (
    <span className={marked.trim() === '' ? undefined : 'mark-block'}>
      {start}
      {entries.map(([key, inner], i) => (
        <span key={key} className="js-line" style={{ paddingInlineStart: `${(depth + 1) * 1.1}em` }}>
          {Array.isArray(value) ? null : <span className="js-key">"{key}": </span>}
          <Json value={inner} path={path === '' ? key : `${path}.${key}`} view={view} open={open} toggle={toggle} depth={depth + 1} />
          {i < entries.length - 1 ? ',' : ''}
        </span>
      ))}
      <span className="js-line" style={{ paddingInlineStart: `${depth * 1.1}em` }}>
        {end}
      </span>
    </span>
  );
}

const DIRECTION_LABELS: Readonly<Record<PayloadView['direction'], string>> = { request: 'Request to the model', response: 'Model response', tool_result: 'Tool result' };

function Payloads({ views }: { readonly views: readonly PayloadView[] }) {
  const [tab, setTab] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const view = views[Math.min(tab, views.length - 1)]!;
  const toggle = (path: string) => setOpen((current) => new Set([...current, path]));
  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(view.value, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="mk-payload">
      <div className="mk-payload-bar">
        {views.length === 1 ? (
          <span className="mk-payload-label">{DIRECTION_LABELS[view.direction]}</span>
        ) : (
          <span role="tablist" className="mk-tabs">
            {views.map((candidate, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>
                {DIRECTION_LABELS[candidate.direction]}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="mk-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mk-json">
        <Json value={view.value} path="" view={view} open={open} toggle={toggle} depth={0} />
      </pre>
      <p className="mk-caption">
        From a real run:{' '}
        <a href={view.url} title={view.file}>
          {view.caption}
        </a>
      </p>
    </div>
  );
}

function One({ mock }: { readonly mock: Exclude<Shown, PayloadView> }) {
  switch (mock.kind) {
    case 'text':
      return (
        <p className="mk-text">
          <Code text={mock.text} />
        </p>
      );
    case 'permission':
      return <Permission mock={mock} />;
    case 'question':
      return <Question mock={mock} />;
    case 'notice':
      return (
        <div className={`mk-notice ${mock.tone ?? 'info'}`}>
          <p className="mk-title">{mock.text}</p>
          {mock.detail === undefined ? null : <p className="mk-muted">{mock.detail}</p>}
          <Actions actions={mock.actions} />
        </div>
      );
    case 'step':
      return <Step mock={mock} />;
    case 'message':
      return <Message mock={mock} />;
    case 'toast':
      return (
        <div className="mk-toast">
          <span>{mock.text}</span>
          <Actions actions={mock.actions} />
        </div>
      );
    case 'composer':
      return <Composer mock={mock} />;
    case 'task':
      return <Task mock={mock} />;
  }
}

/** The "What you see" figure: UI mocks in order, with every payload gathered into one tabbed viewer. */
export default function Sees({ shown }: { readonly shown: readonly Shown[] }) {
  if (shown.length === 0) return null;
  const payloads = shown.filter((item): item is PayloadView => item.kind === 'payload');
  const screens = shown.filter((item): item is Exclude<Shown, PayloadView> => item.kind !== 'payload');
  return (
    <>
      {screens.length === 0 ? null : (
        <figure className="sees">
          <figcaption>What you see</figcaption>
          <div className="mk">
            {screens.map((mock, i) => (
              <One key={i} mock={mock} />
            ))}
          </div>
        </figure>
      )}
      {payloads.length === 0 ? null : (
        <figure className="sees">
          <figcaption>On the wire</figcaption>
          <Payloads views={payloads} />
        </figure>
      )}
    </>
  );
}
