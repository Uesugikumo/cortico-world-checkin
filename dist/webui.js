// Where Are You · 状态
// 手写产物：上面是开关和状态，最底下是眼下采到的前台窗口。
// 真正干活的是 World 那边的 invoke('probe', …)，这里不 import 任何运行时。

const REFRESH_MS = 5000;

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function mountProbe(ctx) {
  const ui = ctx.ui;
  // 面板标签已经写着「状态」，卡片自己不再重复一个标题。
  const sheet = ui.sheet({ title: '' });
  const head = sheet.el.querySelector('h3');
  if (head) head.remove();

  const shotPill = ui.pill('—', 'plain');
  const pokePill = ui.pill('—', 'plain');
  const companionPill = ui.pill('—', 'plain');
  const watchPill = ui.pill('—', 'plain');
  const intervalText = ui.h('span', 'mono', '—');
  const rateText = ui.h('span', 'mono', '—');
  const awayText = ui.h('span', 'mono', '—');
  const backPill = ui.pill('—', 'plain');
  const procText = ui.h('span', 'mono', '—');
  const titleText = ui.h('span', 'mono', '—');
  const idleText = ui.h('span', 'mono', '—');
  const streakText = ui.h('span', 'mono', '—');
  const recentText = ui.h('span', '', '—');
  const message = ui.msgline('');

  sheet.body.append(
    ui.field('监测', watchPill),
    ui.field('采样间隔', intervalText),
    ui.field('搭话时截图', shotPill),
    ui.field('连戳两下桌宠', pokePill),
    ui.field('连摸两下桌宠', companionPill),
    ui.field('今天已说', rateText),
    ui.field('离开判定 / 回来问候', awayText),
    ui.field('现在', backPill),
    ui.section('当前采集到的信息'),
    ui.field('前台程序', procText),
    ui.field('窗口标题', titleText),
    ui.field('键鼠空闲', idleText),
    ui.field('连续同一程序', streakText),
    ui.field('最近一小时', recentText),
    message,
  );
  ctx.root.appendChild(sheet.el);

  function humanIdle(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const min = Math.floor(ms / 60000);
    if (min < 1) return '刚刚还在动';
    if (min < 60) return `${min} 分钟没动`;
    const hour = Math.floor(min / 60);
    return `${hour} 小时 ${min % 60} 分钟没动`;
  }

  function render(st) {
    if (!st) {
      watchPill.textContent = '读不到';
      watchPill.className = 'pill off';
      return;
    }
    const quietNow = Boolean(st.quiet);
    watchPill.textContent = st.watching === false ? '关着' : quietNow ? '安静时段' : '看着呢';
    watchPill.className = 'pill ' + (st.watching === false || quietNow ? 'off' : 'on');

    intervalText.textContent = st.sampleSeconds ? `每 ${st.sampleSeconds} 秒` : '—';

    const fg = st.foreground || null;
    procText.textContent = fg && fg.proc ? `${fg.proc}${fg.media ? ' · 视频' : ''}` : '—';
    titleText.textContent = fg && fg.title ? fg.title : '—';
    idleText.textContent = fg ? humanIdle(fg.idleMs) : '—';
    streakText.textContent = Number.isFinite(st.streakMinutes) ? `${st.streakMinutes} 分钟` : '—';
    const lim = st.limits || {};
    const said = Number.isFinite(st.saidToday) ? st.saidToday : 0;
    const dayCap = Number.isFinite(lim.perDay) ? lim.perDay : '—';
    const hourCap = Number.isFinite(lim.perHour) && lim.perHour > 0 ? ` · 每小时 ${lim.perHour}` : ' · 每小时不限';
    rateText.textContent = `${said} / ${dayCap}${hourCap} · 间隔 ${lim.gap ?? '—'} 分钟 · 待满 ${lim.sameApp ?? '—'} 分钟`;
    recentText.textContent = st.recentHour || '—';
    const sees = st.canSeeImages;
    if (st.screenshot === false) { shotPill.textContent = '关着'; shotPill.className = 'pill off'; }
    else if (sees === false) { shotPill.textContent = '模型看不了图'; shotPill.className = 'pill off'; }
    else if (sees === true) { shotPill.textContent = '开'; shotPill.className = 'pill on'; }
    else { shotPill.textContent = '开（没确认）'; shotPill.className = 'pill plain'; }
    if (st.pokeNudge === false) { pokePill.textContent = '关着'; pokePill.className = 'pill off'; }
    else { pokePill.textContent = '连戳两下就说话'; pokePill.className = 'pill on'; }
    const every = Number.isFinite(st.companionEveryMinutes) ? st.companionEveryMinutes : 2;
    const span = Number.isFinite(st.companionMinutes) ? st.companionMinutes : 10;
    const eyes = Number.isFinite(st.companionTotal) ? st.companionTotal : 5;
    if (st.companion === false) { companionPill.textContent = '关着'; companionPill.className = 'pill off'; }
    else if (st.companionNow) { companionPill.textContent = `陪着呢 · 还剩 ${st.companionLeft ?? 0} 分钟`; companionPill.className = 'pill on'; }
    else { companionPill.textContent = `摸两下陪着看 ${span} 分钟（每 ${every} 分钟一眼，共 ${eyes} 眼）`; companionPill.className = 'pill on'; }
    const away = Number.isFinite(st.awayMinutes) ? st.awayMinutes : 15;
    awayText.textContent = `${away} 分钟没动键鼠算离开 · 回来${st.backNudge === false ? '不说' : '说一句'}`;
    if (st.awaySince) { backPill.textContent = '人不在'; backPill.className = 'pill off'; }
    else { backPill.textContent = '在'; backPill.className = 'pill on'; }
  }

  function say(text, bad) {
    message.textContent = text || '';
    message.classList.toggle('bad', Boolean(bad));
  }

  async function refresh() {
    try {
      const st = await ctx.invoke('status');
      if (ctx.signal && ctx.signal.aborted) return;
      render(st);
      say('', false);
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`读不到状态：${errText(err)}`, true);
    }
  }

  void refresh();
  ctx.interval(() => {
    void refresh();
  }, REFRESH_MS);
}

function mountPending(ctx) {
  const ui = ctx.ui;
  const sheet = ui.sheet({
    title: '待跟进',
    desc: '它记着以后要回头问的事。到点会自己提，这里可以先看，也能直接结掉。提醒过一次、之后一直没有结果的会自动清掉，清多久就在下面改（改完自动存）。',
  });

  const table = ui.table({ head: ['#', '要跟进的事', '什么时候提', ''], maxHeight: '320px' });
  const totalText = ui.h('span', 'mono', '—');
  const staleInput = ui.input({ type: 'number', value: '60', placeholder: '60', cls: 'mono' });
  const staleInputBar = ui.rowbar();
  staleInputBar.append(staleInput);
  const staleHint = ui.h('div', 'tdesc', '改个数字就存好，不用点按钮。');
  const message = ui.msgline('');
  const refreshBtn = ui.button('刷新', { size: 'sm', onClick: () => void refresh() });
  const bar = ui.rowbar();
  bar.append(refreshBtn);

  sheet.body.append(
    ui.field('共几条', totalText),
    table.el,
    ui.field('提醒过的跟进多久清掉（分钟，5–1440）', staleInputBar),
    staleHint,
    bar,
    message,
  );
  ctx.root.appendChild(sheet.el);

  let busy = false;

  function say(text, bad) {
    message.textContent = text || '';
    message.classList.toggle('bad', Boolean(bad));
  }

  async function closeOne(id) {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    try {
      const res = await ctx.invoke('close', [{ id }]);
      if (ctx.signal && ctx.signal.aborted) return;
      render(res);
      say(`结掉了 #${id}。`, false);
      ui.toast('结掉了', 'ok');
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`没结成：${errText(err)}`, true);
      ui.toast('没结成', 'bad');
    } finally {
      busy = false;
      refreshBtn.disabled = false;
    }
  }

  let saving = false;
  let saveAgain = false;
  let saveTimer = 0;
  let lastSaved = null;

  /** 数字一变就存：输入时停顿 800ms 存一次，回车/离开输入框立刻存。 */
  async function saveStale(quiet) {
    if (saving) {
      saveAgain = true;
      return;
    }
    const raw = Number(staleInput.value);
    if (!Number.isFinite(raw)) {
      say('这里要填数字（分钟）。', true);
      if (lastSaved !== null) staleInput.value = String(lastSaved);
      return;
    }
    const minutes = Math.min(1440, Math.max(5, Math.round(raw)));
    if (minutes === lastSaved) return;
    saving = true;
    try {
      const res = await ctx.invoke('save', [{ staleMinutes: minutes }]);
      if (ctx.signal && ctx.signal.aborted) return;
      lastSaved = minutes;
      const clamped = minutes !== Math.round(raw);
      render(res);
      if (!quiet) say(`改了：提醒过的跟进 ${minutes} 分钟没结果就自动清掉。`, false);
      ui.toast(clamped ? `按 ${minutes} 分钟算（范围 5–1440）` : '存好了', 'ok');
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`没存上：${errText(err)}`, true);
      ui.toast('没存上', 'bad');
      if (lastSaved !== null) staleInput.value = String(lastSaved);
    } finally {
      saving = false;
      refreshBtn.disabled = false;
      if (saveAgain) {
        saveAgain = false;
        void saveStale(true);
      }
    }
  }

  function flushSave(quiet) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    void saveStale(quiet);
  }

  staleInput.addEventListener('input', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      void saveStale(true);
    }, 800);
  });
  staleInput.addEventListener('change', () => flushSave(false));
  staleInput.addEventListener('blur', () => flushSave(true));

  function render(res) {
    const list = (res && Array.isArray(res.threads) ? res.threads : []).slice();
    const stale = res && Number.isFinite(res.staleMinutes) ? res.staleMinutes : 60;
    lastSaved = stale;
    totalText.textContent = `${list.length} 条（提醒过的 ${stale} 分钟没结果会自动清）`;
    if (typeof document === 'undefined' || document.activeElement !== staleInput) {
      staleInput.value = String(stale);
    }
    staleHint.textContent = `改个数字就存好。提醒过一次、之后一直没有结果的跟进，过了 ${stale} 分钟自动清掉。`;
    table.clear(list.length ? '' : '还没有要跟进的事。');
    for (const t of list) {
      const btn = ui.button('结掉', { size: 'sm', onClick: () => void closeOne(t.id) });
      const asked = t.asked ? '（提醒过）' : '';
      table.addRow([`#${t.id}`, t.text, `${t.dueText || '—'}${t.overdue ? '（到点了）' : ''}${asked}`, btn]);
    }
  }

  async function refresh() {
    if (busy) return;
    try {
      const res = await ctx.invoke('list', []);
      if (ctx.signal && ctx.signal.aborted) return;
      render(res);
      say('', false);
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`读不到：${errText(err)}`, true);
    }
  }

  void refresh();
  ctx.interval(() => {
    void refresh();
  }, 15000);
}

const bundle = { panels: { probe: { mount: mountProbe }, pending: { mount: mountPending } } };

export { bundle as default };
