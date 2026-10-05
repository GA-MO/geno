(() => {
  const { turns, live, model, context, suggestions } = window.T;
  const transcript = document.getElementById('transcript');
  const composer = document.getElementById('composer');

  const TOOL = { search: 'grep', read: 'read', edit: 'edit', bash: 'bash' };
  const GLYPH = { done: '✓', waiting: '?', running: '' };

  /** One log line per tool call, columns aligned like a terminal, nothing grouped away. */
  const line = (s) => {
    const status = s.status ?? 'done';
    const detail = s.add ? `<span class="add">+${s.add}</span> <span class="del">−${s.del}</span>` : s.detail ?? 'needs approval';
    return `<div class="line ${status}"><span class="glyph">${GLYPH[status]}</span><span class="tool">${TOOL[s.kind]}</span><span class="arg">${s.target}</span><span class="detail">${detail}</span><span class="ms">${s.ms ? `${s.ms}ms` : ''}</span></div>`;
  };

  const code = ({ file, lang, html }) => `
    <figure class="px code"><figcaption><span>${file}</span><span class="keys"><kbd>c</kbd> copy <kbd>o</kbd> open</span></figcaption><pre><code>${html}</code></pre></figure>`;

  const patch = (diff) => `
    <section class="px patch">
      <header><span class="label">${diff.length} files</span><span class="add">+${diff.reduce((n, f) => n + f.add, 0)}</span><span class="del">−${diff.reduce((n, f) => n + f.del, 0)}</span><span class="keys"><button class="key"><kbd>u</kbd>undo all</button><button class="key go"><kbd>k</kbd>keep all</button></span></header>
      ${diff
        .map(
          (f) => `<div class="file"><span class="name">${f.file}</span><span class="add">+${f.add}</span><span class="del">−${f.del}</span></div>
          ${f.lines.map(([k, n, text]) => `<div class="ln ${k === '+' ? 'ins' : k === '-' ? 'rem' : ''}"><span class="n">${n}</span><span class="k">${k}</span><span>${text.replace(/</g, '&lt;')}</span></div>`).join('')}`,
        )
        .join('')}
    </section>`;

  const ask = (p) => `
    <section class="px ask">
      <div class="q"><span class="mark">?</span>run <b>${p.command}</b></div>
      <p>${p.reason}</p>
      <div class="keys"><button class="key go"><kbd>⏎</kbd>allow</button><button class="key"><kbd>esc</kbd>deny</button><button class="key"><kbd>a</kbd>always allow rm here</button></div>
    </section>`;

  const turn = (t) => {
    const a = t.answer;
    const prose = a
      ? t.streaming
        ? `${a.intro}${code(a.code)}<p>A chat turn loops between the model and the tools until<span class="caret"></span></p>`
        : `${a.intro}${code(a.code)}${a.lead}<figure class="px diagram">${a.diagram}<figcaption><span>flowchart</span><span class="keys"><kbd>c</kbd> copy source <kbd>o</kbd> open full size</span></figcaption></figure>${a.list}`
      : `<p>${t.text}</p>`;
    const state = t.permission ? 'waiting' : t.streaming ? 'live' : 'done';
    return `
      <section class="blk you"><span class="prompt">›</span><div>${t.prompt}</div></section>
      <section class="blk agent ${state}">
        <header class="head"><span class="dino">${dino('frill')}</span><span class="who">g-code</span><span class="state">${t.usage ? `done in ${t.usage.seconds}s` : t.permission ? 'waiting on you' : 'writing'}</span></header>
        ${a ? '' : `<div class="prose">${prose}</div>`}
        <div class="log">
          ${t.thought ? `<div class="line thought"><span class="glyph">~</span><span class="tool">think</span><span class="arg">${t.thought.text}</span><span class="detail"></span><span class="ms">${t.thought.seconds}s</span></div>` : ''}
          ${(t.steps ?? []).map(line).join('')}
        </div>
        ${t.permission ? ask(t.permission) : ''}
        ${a ? `<div class="prose">${prose}</div>` : ''}
        ${t.diff && t.diff.length ? patch(t.diff) : ''}
        ${t.usage ? `<footer class="strip"><span>${t.usage.model}</span><span>${t.usage.input} in</span><span>${t.usage.output} out</span><span>${t.usage.cost}</span></footer>` : ''}
      </section>`;
  };

  const empty = () => `
    <section class="empty">
      <span class="dino big">${dino('frill')}</span>
      <h1>g-code is ready.</h1>
      <p>Type what you want changed, or pick one to start.</p>
      <ol class="starts">${suggestions.map((s, i) => `<li><kbd>${i + 1}</kbd>${s}</li>`).join('')}</ol>
    </section>`;

  transcript.innerHTML = turns.length ? turns.map(turn).join('') : empty();
  composer.innerHTML = `
    <div class="line-in"><span class="prompt">›</span><span class="ph">${turns.length ? 'follow up, or / for commands' : 'describe the change'}</span><span class="cursor"></span></div>
    <div class="status">
      <span>${model}</span>${context.map((c) => `<span>@${c}</span>`).join('')}
      <span class="hint">${live ? '<kbd>esc</kbd> stop' : '<kbd>⏎</kbd> send'}</span>
    </div>`;
  settle(transcript);
})();
