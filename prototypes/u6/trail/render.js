(() => {
  const { turns, live, model, context, suggestions } = window.T;
  const transcript = document.getElementById('transcript');
  const composer = document.getElementById('composer');

  /** Consecutive reads or edits collapse into one row of file chips; the rail reads as a process, not a log. */
  const groups = (steps) =>
    steps.reduce((out, step) => {
      const last = out[out.length - 1];
      if (last && last.kind === step.kind && step.kind !== 'search' && step.kind !== 'bash') last.items.push(step);
      else out.push({ kind: step.kind, verb: step.verb, icon: step.icon, items: [step] });
      return out;
    }, []);

  const chip = (s) =>
    `<span class="chip">${icon('file-code')}${s.target.replace('src/', '')}${s.add ? `<span class="add">+${s.add}</span><span class="del">−${s.del}</span>` : ''}</span>`;

  const stepRow = (g) => {
    if (g.kind === 'search') {
      const s = g.items[0];
      return node('done', `${icon('search')}<span class="verb">Searched</span><code class="target">${s.target}</code><span class="meta">${s.detail}</span>`);
    }
    if (g.kind === 'bash') {
      const s = g.items[0];
      return node('wait', `${icon('terminal')}<span class="verb">Wants to run</span><code class="target">${s.target}</code><span class="meta">waiting for you</span>`);
    }
    return node('done', `${icon(g.icon)}<span class="verb">${g.verb}</span><span class="chips">${g.items.map(chip).join('')}</span>`);
  };

  const node = (status, body, extra = '') => `<li class="step ${status}"><span class="dot"></span><div class="row">${body}</div>${extra}</li>`;

  const codeBlock = ({ file, html }) => `
    <figure class="code">
      <figcaption><span>${icon('file-code')}${file}</span><span class="tools">${icon('copy')}${icon('go-to-file')}</span></figcaption>
      <pre><code>${html}</code></pre>
    </figure>`;

  const diffCard = (files) => `
    <section class="diff">
      <header>
        <span class="title">${icon('diff')}${files.length} files changed</span>
        <span class="add">+${files.reduce((n, f) => n + f.add, 0)}</span><span class="del">−${files.reduce((n, f) => n + f.del, 0)}</span>
        <span class="actions"><button class="ghost">Undo all</button><button class="primary">Keep all</button></span>
      </header>
      ${files
        .map(
          (f, i) => `
        <details ${i === 0 ? 'open' : ''}>
          <summary>${icon(i === 0 ? 'chevron-down' : 'chevron-right')}<span class="file">${f.file}</span><span class="add">+${f.add}</span><span class="del">−${f.del}</span></summary>
          ${i === 0 ? `<pre class="hunk">${f.lines.map(([k, n, t]) => `<span class="ln ${k === '+' ? 'ins' : k === '-' ? 'rem' : ''}"><span class="no">${n}</span><span class="sign">${k}</span>${t}</span>`).join('')}</pre>` : ''}
        </details>`,
        )
        .join('')}
    </section>`;

  const permission = (p) => `
    <section class="permission">
      <header>${icon('shield')}<strong>Run this command?</strong></header>
      <pre class="cmd"><span class="prompt">$</span> ${p.command}</pre>
      <p class="reason">${p.reason}</p>
      <div class="actions"><button class="primary">Allow</button><button class="secondary">Deny</button><button class="ghost">Always allow in this workspace</button></div>
    </section>`;

  const assistantHead = (t) => `
    <div class="who"><span class="dino avatar">${dino('noodle')}</span><span class="name">g-code</span>
    ${t.usage ? `<span class="meta">worked for ${t.usage.seconds}s</span>` : t.streaming ? '<span class="meta shimmer">Writing</span>' : '<span class="meta">waiting</span>'}</div>`;

  const turn = (t) => {
    const steps = t.steps ? groups(t.steps) : [];
    const answer = t.answer
      ? t.streaming
        ? `${t.answer.intro}${codeBlock(t.answer.code)}<p>A chat turn loops between the model and the tools until<span class="caret"></span></p>`
        : `${t.answer.intro}${codeBlock(t.answer.code)}${t.answer.lead}<figure class="diagram">${t.answer.diagram}<figcaption>${icon('type-hierarchy-sub')}flowchart${icon('copy')}${icon('screen-full')}</figcaption></figure>${t.answer.list}`
      : '';
    return `
      <article class="turn">
        <div class="user"><div class="bubble">${t.prompt}</div></div>
        ${assistantHead(t)}
        <ol class="rail">
          ${t.thought ? node('thought', `${icon('lightbulb')}<span class="verb">Thought for ${t.thought.seconds}s</span>${icon('chevron-right', 'more')}`) : ''}
          ${t.text ? `<li class="step prose"><span class="dot"></span><p>${t.text}</p></li>` : ''}
          ${steps.filter((g) => !(t.permission && g.kind === 'bash')).map(stepRow).join('')}
          ${t.permission ? `<li class="step card wait"><span class="dot"></span>${permission(t.permission)}</li>` : ''}
          ${answer ? `<li class="step answer ${t.streaming ? 'live' : ''}"><span class="dot"></span><div class="md">${answer}</div></li>` : ''}
          ${t.diff && t.diff.length ? `<li class="step card done"><span class="dot"></span>${diffCard(t.diff)}</li>` : ''}
        </ol>
        ${t.usage ? `<p class="usage"><span>${t.usage.model}</span><span>${t.usage.input} in</span><span>${t.usage.output} out</span><span>${t.usage.cost}</span></p>` : ''}
      </article>`;
  };

  const empty = () => `
    <div class="empty">
      <span class="dino hero">${dino('noodle')}</span>
      <h1>Ask for a change</h1>
      <p>g-code reads your files, asks before risky commands, and keeps every edit reviewable.</p>
      <ul class="suggest">${suggestions.map((s, i) => `<li>${icon(['book', 'search', 'beaker'][i])}${s}</li>`).join('')}</ul>
    </div>`;

  transcript.innerHTML = turns.length ? turns.map(turn).join('') : empty();
  composer.innerHTML = `
    <div class="box ${turns.length ? '' : 'focus'}">
      <div class="context">${context.map((c, i) => `<span class="ctx">${icon(i ? 'book' : 'file-code')}${c}</span>`).join('')}<span class="ctx add">${icon('add')}</span></div>
      <div class="input">${turns.length ? 'Ask a follow-up' : 'Describe the change you want'}</div>
      <div class="bar"><span class="model">${icon('sparkle')}${model}${icon('chevron-down')}</span><span class="mode">${icon('shield')}Ask before running</span>
        <button class="send ${live ? 'stop' : ''}" aria-label="${live ? 'Stop' : 'Send'}">${icon(live ? 'debug-stop' : 'arrow-up')}</button></div>
    </div>`;
  settle(transcript);
})();
