(() => {
  const { turns, live, model, context, suggestions } = window.T;
  const transcript = document.getElementById('transcript');
  const composer = document.getElementById('composer');

  const KINDS = {
    search: { icon: 'search', one: 'search', many: 'searches' },
    read: { icon: 'eye', one: 'read', many: 'reads' },
    edit: { icon: 'edit', one: 'edit', many: 'edits' },
    bash: { icon: 'terminal', one: 'command', many: 'commands' },
  };

  /** The run as a strip: one segment per step, colored by kind, with a count per kind beside it. */
  const progress = (t) => {
    const steps = t.steps ?? [];
    const counts = Object.entries(steps.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {}));
    const waiting = steps.some((s) => s.status === 'waiting');
    const time = t.usage ? `${t.usage.seconds}s` : waiting ? 'paused' : 'working';
    return `
      <div class="run">
        <div class="track">${steps.map((s) => `<span class="seg ${s.kind} ${s.status ?? 'done'}"></span>`).join('')}${t.streaming ? '<span class="seg answer live"></span>' : ''}</div>
        <div class="tally">
          ${counts.map(([k, n]) => `<span class="count ${k}">${icon(KINDS[k].icon)}${n} ${n === 1 ? KINDS[k].one : KINDS[k].many}</span>`).join('')}
          <span class="time ${t.usage ? '' : 'live'}">${time}</span>
          <span class="toggle">Steps${icon('chevron-down')}</span>
        </div>
      </div>`;
  };

  const codeBlock = ({ file, html }) => `
    <figure class="bleed code"><figcaption>${file}<span>${icon('copy')}Copy</span></figcaption><pre><code>${html}</code></pre></figure>`;

  const files = (diff) => `
    <section class="attach">
      <div class="tabs">${diff.map((f, i) => `<span class="tab ${i === 0 ? 'on' : ''}">${f.file.replace('src/', '')}<b class="add">+${f.add}</b><b class="del">−${f.del}</b></span>`).join('')}</div>
      <pre class="hunk">${diff[0].lines.map(([k, n, text]) => `<span class="ln ${k === '+' ? 'ins' : k === '-' ? 'rem' : ''}"><i>${n}</i>${text}</span>`).join('')}</pre>
      <div class="decide"><span>3 files changed, waiting for review</span><button class="quiet">Undo all</button><button class="solid">Keep all</button></div>
    </section>`;

  const ask = (p) => `
    <section class="ask">
      <div class="ask-head">${icon('shield')}<span>g-code wants to run a command</span></div>
      <pre class="cmd">${p.command}</pre>
      <p>${p.reason}</p>
      <div class="choices"><button class="solid">Allow once</button><button class="quiet">Deny</button></div>
      <span class="always">${icon('check-all')}Always allow <code>rm</code> in this workspace</span>
    </section>`;

  const sheet = (t, i) => {
    const a = t.answer;
    const body = a
      ? t.streaming
        ? `${a.intro}${codeBlock(a.code)}<p>A chat turn loops between the model and the tools until<span class="caret"></span></p>`
        : `${a.intro}${codeBlock(a.code)}${a.lead}<figure class="bleed canvas">${a.diagram}<figcaption>${icon('type-hierarchy-sub')}Flowchart<span>${icon('copy')}${icon('link-external')}</span></figcaption></figure>${a.list}`
      : `<p>${t.text}</p>`;
    return `
      <article class="sheet ${t.permission ? 'waiting' : ''} ${t.streaming ? 'streaming' : ''}">
        <header class="prompt"><h2>${t.prompt}</h2></header>
        ${progress(t)}
        <div class="body">${body}</div>
        ${t.permission ? ask(t.permission) : ''}
        ${t.diff && t.diff.length ? files(t.diff) : ''}
        ${t.usage ? `<footer class="usage"><span class="dino">${dino('plato')}</span><span>${t.usage.model}</span><span class="spacer"></span><span>${t.usage.input} in</span><span>${t.usage.output} out</span><span>${t.usage.cost}</span></footer>` : ''}
      </article>`;
  };

  const empty = () => `
    <div class="empty">
      <span class="dino">${dino('plato')}</span>
      <h1>What should change?</h1>
      <p>Describe it in your words. g-code plans the steps, shows each edit, and asks before it runs anything risky.</p>
      <div class="starters">${suggestions.map((s, i) => `<div class="starter"><span class="ico">${icon(['book', 'search', 'beaker'][i])}</span><span><strong>${s}</strong><small>${['Uses the open editor', 'Searches the workspace', 'Adds a file under test/'][i]}</small></span></div>`).join('')}</div>
    </div>`;

  transcript.innerHTML = turns.length ? turns.map(sheet).join('') : empty();
  composer.innerHTML = `
    <div class="field ${turns.length ? '' : 'focus'}">
      <div class="input">${turns.length ? 'Ask a follow-up' : 'Describe the change you want'}</div>
      <div class="bar">
        <span class="pill">${icon('add')}</span>
        ${context.map((c) => `<span class="pill">${c}</span>`).join('')}
        <span class="spacer"></span>
        <span class="model">${model}${icon('chevron-down')}</span>
        <button class="go ${live ? 'stop' : ''}" aria-label="${live ? 'Stop' : 'Send'}">${icon(live ? 'debug-stop' : 'send')}</button>
      </div>
    </div>`;
  settle(transcript);
})();
