import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { FACES, GHOST_OPTIONS, MEMORY_SCOPES, NEEDS_APPROVAL, NO_ARGUMENTS } from '../scenario/faces.js';
import { codeSegments } from '../scenario/labels.js';
import type { Shown } from '../scenario/model.js';
import type { BlockChip, Long, More, PayloadView } from '../scenario/payload.js';

type Mock<K extends Shown['kind']> = Extract<Shown, { kind: K }>;

export const Code = ({ text }: { readonly text: string }): ReactNode =>
  codeSegments(text).map((segment, i) => (segment.code ? <code key={i}>{segment.text}</code> : <span key={i}>{segment.text}</span>));

function Permission({ mock }: { readonly mock: Mock<'permission'> }) {
  const face = FACES[mock.face ?? 'command'];
  const options = mock.options ?? face.options;
  return (
    <div className="mk-permission">
      <p className="mk-title">{face.title(mock)}</p>
      {mock.face === 'mcp' && mock.command === '' ? (
        <p className="mk-muted">{NO_ARGUMENTS}</p>
      ) : (
        <pre className="mk-command" aria-label={mock.face === 'mcp' ? 'Arguments' : undefined}>
          {mock.line ?? mock.command}
        </pre>
      )}
      {mock.line === undefined ? null : (
        <p className="mk-muted">
          {NEEDS_APPROVAL}
          <code>{mock.command}</code>
        </p>
      )}
      {mock.face === 'memory' ? <p className="mk-muted">{MEMORY_SCOPES[mock.scope ?? 'project']}</p> : null}
      {mock.reason === undefined ? null : <p className="mk-muted">{mock.reason}</p>}
      {mock.rule === undefined ? null : (
        <p className="mk-muted">
          Always allow saves the rule <code>{mock.rule}</code> for this workspace. Settings lists its rules.
        </p>
      )}
      {mock.note === undefined ? null : <p className="mk-input">{mock.note}</p>}
      <p className="mk-buttons">
        {options.map((option, i) => (
          <span key={option} className={`mk-button${i === 0 ? ' primary' : GHOST_OPTIONS.has(option) ? ' ghost' : ''}${option === mock.chosen ? ' chosen' : ''}`}>
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

/** A string's JSON text with every occurrence of the quote marked. */
function Quoted({ text, quote }: { readonly text: string; readonly quote: string | undefined }): ReactNode {
  const needle = quote === undefined ? '' : JSON.stringify(quote).slice(1, -1);
  if (needle === '' || !text.includes(needle)) return text;
  return text.split(needle).map((part, i) => (
    <span key={i}>
      {i === 0 ? null : <mark className="js-quote">{needle}</mark>}
      {part}
    </span>
  ));
}

const isLong = (value: unknown): value is Long => typeof value === 'object' && value !== null && '$long' in value;
const isMore = (value: unknown): value is More => typeof value === 'object' && value !== null && '$more' in value;

function Json({ value, path, view, open, toggle, depth }: { readonly value: unknown; readonly path: string; readonly view: PayloadView; readonly open: ReadonlySet<string>; readonly toggle: (path: string) => void; readonly depth: number }): ReactNode {
  const marked = view.highlight.includes(path) ? ' mark' : '';
  if (isLong(value))
    return (
      <span className={`js-string${marked}`}>
        "{value.from === 0 ? null : <span className="js-cut">… </span>}
        <Quoted text={JSON.stringify(value.$long).slice(1, -1)} quote={view.quote} />
        <span className="js-cut"> … {`${value.chars.toLocaleString('en-US')} ตัวอักษร`}</span>"
      </span>
    );
  if (isMore(value)) return <span className="js-cut">… อีก {value.$more} รายการ</span>;
  if (typeof value === 'string')
    return (
      <span className={`js-string${marked}`}>
        "<Quoted text={JSON.stringify(value).slice(1, -1)} quote={view.quote} />"
      </span>
    );
  if (value === null || typeof value !== 'object') return <span className={`js-${value === null ? 'null' : typeof value}${marked}`}>{JSON.stringify(value)}</span>;
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
  const [start, end] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const folded = view.collapse.includes(path) && !open.has(path);
  if (entries.length === 0) return <span className={marked.trim()}>{start + end}</span>;
  if (folded)
    return (
      <button type="button" className="js-fold" data-path={path} onClick={() => toggle(path)}>
        {start} {Array.isArray(value) ? `${value.length} รายการ` : `${entries.length} key`} {end}
      </button>
    );
  return (
    <span className={marked.trim() === '' ? undefined : 'mark-block'} data-path={path}>
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

const PROVENANCE_LABELS: Readonly<Record<PayloadView['provenance'], string>> = {
  recorded: 'ไบต์จริงจาก wire log',
  rebuilt: 'request ที่ engine สร้างใหม่จาก session log ตอนเก็บผล',
  logged: 'event ใน session log',
  scripted: 'บันทึกจาก engine จริงกับ model จำลอง',
};

/** A figure's title says whether a real model or a scripted one answered the engine. */
function payloadsCaption(views: readonly PayloadView[]): string {
  const scripted = views.filter((view) => view.provenance === 'scripted').length;
  return scripted === 0 ? 'ข้อมูลจากการรันจริง' : scripted === views.length ? 'ข้อมูลจาก engine จริงกับ model จำลอง' : 'ข้อมูลจากการรันจริงและจาก model จำลอง';
}

const chipLabel =(chip: BlockChip): string => (chip.name === undefined ? chip.type : `${chip.type} ${chip.name}`);

/** Whether a card shows a tool_use block, so the page explains how to read one. */
export const showsToolUse = (shown: readonly Shown[]): boolean =>
  shown.some((item) => item.kind === 'payload' && (item.blocks ?? []).some((chip) => chip.type === 'tool_use' && chip.at !== undefined));

/** The blocks of the message, in order; a chip scrolls the JSON to its block. */
function Chips({ chips, json }: { readonly chips: readonly BlockChip[]; readonly json: RefObject<HTMLPreElement | null> }) {
  const reveal = (at: string) => {
    const pre = json.current;
    const block = pre?.querySelector<HTMLElement>(`[data-path="${at}"]`);
    if (pre === null || pre === undefined || block === null || block === undefined) return;
    pre.scrollTo({ top: pre.scrollTop + block.getBoundingClientRect().top - pre.getBoundingClientRect().top - 6, behavior: 'smooth' });
    block.classList.remove('flash');
    void block.offsetWidth;
    block.classList.add('flash');
  };
  return (
    <p className="mk-chips" aria-label={`${chips.length} block ในข้อความนี้`}>
      {chips.map((chip, i) =>
        chip.at === undefined ? (
          <span key={i} className="mk-chip off" title="block นี้อยู่ในข้อความเดียวกัน แต่การ์ดนี้ไม่ได้แสดง">
            {chipLabel(chip)}
          </span>
        ) : (
          <button key={i} type="button" className={`mk-chip t-${chip.type}`} onClick={() => reveal(chip.at!)}>
            {chipLabel(chip)}
          </button>
        ),
      )}
    </p>
  );
}

/** One payload: its chips, what a log event records or which calls a tool result answers, the JSON, and its source. */
function Panel({ view, legend, hidden }: { readonly view: PayloadView; readonly legend: boolean; readonly hidden: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const json = useRef<HTMLPreElement>(null);
  const toggle = (path: string) => setOpen((current) => new Set([...current, path]));
  return (
    <div className="mk-panel" role="tabpanel" data-unit={view.unit} data-label={view.label} hidden={hidden}>
      {view.blocks === undefined ? null : <Chips chips={view.blocks} json={json} />}
      {view.note === undefined ? null : <p className="mk-note">{view.note}</p>}
      {view.answers === undefined ? null : (
        <p className="mk-answers">
          ตอบ{' '}
          {view.answers.map((answer, i) => (
            <span key={answer.id}>
              {i === 0 ? null : ', '}
              <code>tool_use {answer.name}</code> ({answer.id})
            </span>
          ))}
        </p>
      )}
      {legend && showsToolUse([view]) ? (
        <p className="mk-legend">
          อ่าน block <code>tool_use</code> อย่างนี้: <code>name</code> คือ tool ที่ model เลือกเรียก, <code>input</code> คือ argument ตาม schema ของ tool นั้น และ <code>id</code> ใช้จับคู่กับ{' '}
          <code>tool_result</code> ที่ส่งกลับ
        </p>
      ) : null}
      <pre className="mk-json" ref={json}>
        <Json value={view.value} path="" view={view} open={open} toggle={toggle} depth={0} />
      </pre>
      <p className="mk-caption">
        ที่มา:{' '}
        <a href={view.url} title={view.file}>
          {view.caption}
        </a>
        {` · ${PROVENANCE_LABELS[view.provenance]}${view.engine === undefined ? '' : view.provenance === 'scripted' ? ` (commit ${view.engine})` : ` · engine ${view.engine}`}`}
      </p>
    </div>
  );
}

/** Every payload of a figure as a tab; each panel is in the page, so a reader without JS and the cards check see all. */
function Payloads({ views, legend }: { readonly views: readonly PayloadView[]; readonly legend: boolean }) {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const active = Math.min(tab, views.length - 1);
  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(views[active]!.value, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="mk-payload">
      <div className="mk-payload-bar">
        {views.length === 1 ? (
          <span className="mk-payload-label">{views[0]!.label}</span>
        ) : (
          <span role="tablist" className="mk-tabs">
            {views.map((candidate, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === active} onClick={() => setTab(i)}>
                {candidate.label}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="mk-copy" onClick={copy}>
          {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
        </button>
      </div>
      {views.map((view, i) => (
        <Panel key={i} view={view} legend={legend} hidden={i !== active} />
      ))}
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

/**
 * The "What you see" figure: UI mocks in order, with every payload gathered into one tabbed viewer. `legend` lets a
 * card explain tool_use; a story passes it to its first beat that shows one, and docs.css hides it on later cards.
 */
export default function Sees({ shown, legend = true }: { readonly shown: readonly Shown[]; readonly legend?: boolean }) {
  if (shown.length === 0) return null;
  const payloads = shown.filter((item): item is PayloadView => item.kind === 'payload');
  const screens = shown.filter((item): item is Exclude<Shown, PayloadView> => item.kind !== 'payload');
  return (
    <>
      {screens.length === 0 ? null : (
        <figure className="sees">
          <figcaption>สิ่งที่คุณเห็น</figcaption>
          <div className="mk">
            {screens.map((mock, i) => (
              <One key={i} mock={mock} />
            ))}
          </div>
        </figure>
      )}
      {payloads.length === 0 ? null : (
        <figure className="sees">
          <figcaption>{payloadsCaption(payloads)}</figcaption>
          <Payloads views={payloads} legend={legend} />
        </figure>
      )}
    </>
  );
}
