// Where Are You · 状态
// 手写产物：上面是开关和状态，最底下是眼下采到的前台窗口。
// 真正干活的是 World 那边的 invoke('probe', …)，这里不 import 任何运行时。

const REFRESH_MS = 5000;

// 开关页最底下那行反馈渠道
const FEEDBACK_EMAIL = '1735820759@qq.com';

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** 复制路径：先试剪贴板，再退回 execCommand（Coo 的页面在 http 下也常能成功）。 */
async function copyText(text) {
  if (!text || text === '—') return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面再试一次
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyPath(text, btn) {
  const before = btn.textContent;
  const ok = await copyText(text);
  btn.textContent = ok ? '已复制' : '没复制上';
  window.setTimeout(() => {
    btn.textContent = before;
  }, 1600);
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
  const topPill = ui.pill('—', 'plain');
  const watchPill = ui.pill('—', 'plain');
  const intervalText = ui.h('span', 'mono', '—');
  const rateText = ui.h('span', 'mono', '—');
  const awayText = ui.h('span', 'mono', '—');
  const focusText = ui.h('span', 'mono', '—');
  const backPill = ui.pill('—', 'plain');
  const procText = ui.h('span', 'mono', '—');
  const titleText = ui.h('span', 'mono', '—');
  const idleText = ui.h('span', 'mono', '—');
  const streakText = ui.h('span', 'mono', '—');
  const recentText = ui.h('span', '', '—');
  const message = ui.msgline('');

  const wakePill = ui.pill('—', 'plain');
  const mediaText = ui.h('span', 'mono', '—');
  const journalText = ui.h('span', 'mono', '—');
  const copyMediaBtn = ui.button('复制路径', { size: 'sm', onClick: () => void copyPath(mediaText.textContent, copyMediaBtn) });
  const copyJournalBtn = ui.button('复制路径', { size: 'sm', onClick: () => void copyPath(journalText.textContent, copyJournalBtn) });
  const mediaBar = ui.rowbar();
  mediaBar.append(mediaText, copyMediaBtn);
  const journalBar = ui.rowbar();
  journalBar.append(journalText, copyJournalBtn);

  sheet.body.append(
    ui.field('监测', watchPill),
    ui.field('看一眼屏幕', topPill),
    ui.field('采样间隔', intervalText),
    ui.field('搭话时截图', shotPill),
    ui.field('连戳两下桌宠', pokePill),
    ui.field('连摸两下桌宠', companionPill),
    ui.field('今天已说', rateText),
    ui.field('画面在不在变', focusText),
    ui.field('离开判定 / 回来问候', awayText),
    ui.field('现在', backPill),
    ui.field('心事', wakePill),
    ui.section('当前采集到的信息'),
    ui.field('前台程序', procText),
    ui.field('窗口标题', titleText),
    ui.field('键鼠空闲', idleText),
    ui.field('连续同一程序', streakText),
    ui.field('最近一小时', recentText),
    ui.section('文件在哪'),
    ui.field('附件库', mediaBar),
    ui.field('心事.md', journalBar),
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
    const lookEvery = Number.isFinite(st.lookEveryMinutes) ? st.lookEveryMinutes : 0;
    if (!lookEvery) { topPill.textContent = '关着（只按「持续」给）'; topPill.className = 'pill off'; }
    else if (!st.watching) { topPill.textContent = '监测关着，用不上'; topPill.className = 'pill off'; }
    else if (st.lastLookAt) { topPill.textContent = `每 ${lookEvery} 分钟一眼 · 还有 ${st.lookDueIn ?? 0} 分钟`; topPill.className = 'pill on'; }
    else { topPill.textContent = `每 ${lookEvery} 分钟一眼`; topPill.className = 'pill on'; }
    const every = Number.isFinite(st.companionEveryMinutes) ? st.companionEveryMinutes : 2;
    const span = Number.isFinite(st.companionMinutes) ? st.companionMinutes : 10;
    const eyes = Number.isFinite(st.companionTotal) ? st.companionTotal : 5;
    if (st.companion === false) { companionPill.textContent = '关着'; companionPill.className = 'pill off'; }
    else if (st.companionNow) { companionPill.textContent = `陪着呢 · 还剩 ${st.companionLeft ?? 0} 分钟`; companionPill.className = 'pill on'; }
    else { companionPill.textContent = `摸两下陪着看 ${span} 分钟（每 ${every} 分钟一眼，共 ${eyes} 眼）`; companionPill.className = 'pill on'; }
    const away = Number.isFinite(st.awayMinutes) ? st.awayMinutes : 15;
    const focusIdle = Number.isFinite(st.focusIdleMinutes) ? st.focusIdleMinutes : 3;
    const still = Number.isFinite(st.stillMinutes) ? st.stillMinutes : 10;
    focusText.textContent = st.screenChanging === true
      ? `键鼠停超过 ${focusIdle} 分钟时看画面：刚才还在变，算他还在看`
      : st.screenChanging === false
        ? `键鼠停超过 ${focusIdle} 分钟时看画面：已经 ${still} 分钟没变，算人不在`
        : `键鼠停超过 ${focusIdle} 分钟时看画面：还没取到过`;
    // 这趟离开的「落账」状态只在人不在的时候有意义
    const needBy = Number.isFinite(st.awayVerdictMinutes) ? st.awayVerdictMinutes : away;
    const verdict = !st.awaySince ? '' : st.awayVerdictNoted ? ' · 这趟已落账'
      : st.awayVerdict === 'nagged' ? ' · 补过收尾，仍未落账'
        : ` · 还没落账（${needBy} 分钟后补一次）`;
    awayText.textContent = `${away} 分钟没动键鼠算离开 · 回来${st.backNudge === false ? '不说' : '说一句'}${verdict}`;
    if (st.awaySince) { backPill.textContent = '人不在'; backPill.className = 'pill off'; }
    else { backPill.textContent = '在'; backPill.className = 'pill on'; }

    if (!st.journalOn) {
      wakePill.textContent = '关着';
      wakePill.className = 'pill off';
    } else {
      const modes = [];
      if (st.wakeMode === 'quiet-end' || st.wakeMode === 'both') modes.push('安静时段结束');
      if (st.wakeMode === 'custom' || st.wakeMode === 'both') {
        const times = Array.isArray(st.wakeTimes) ? st.wakeTimes : [];
        modes.push(times.length ? `每 ${times.join('、')}` : '没设时间');
      }
      wakePill.textContent = modes.length ? modes.join(' · ') : '开着';
      wakePill.className = st.wakeMode === 'custom' && !(st.wakeTimes || []).length ? 'pill off' : 'pill on';
    }

    mediaText.textContent = st.media || '—';
    copyMediaBtn.disabled = !st.media;
    journalText.textContent = st.journal || '—';
    copyJournalBtn.disabled = !st.journal;
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
  const sheet = ui.sheet({ title: '' });
  hideHeading(sheet);

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

  // ---- 心事（从设置页挪过来的三项） ----
  const journalCheck = ui.checkbox('让我想', {
    title: '醒来的时候翻一眼心事.md，写下一条',
    onChange: (checked) => void saveJournal({ journal: checked }),
  });
  const wakeModeSeg = ui.segmented(
    [
      { value: 'quiet-end', label: '安静时段结束' },
      { value: 'custom', label: '自定义' },
      { value: 'both', label: '两者' },
    ],
    { size: 'sm', onSelect: (value) => void saveJournal({ wakeMode: value }) },
  );
  const timesInput = ui.input({ type: 'text', value: '', placeholder: '0900, 2130', cls: 'mono' });
  const timesBar = ui.rowbar();
  timesBar.append(timesInput);
  const timesHint = ui.h('div', 'tdesc', '写 0900 这种四位数，逗号隔开多个；全半角逗号、分号、空格都行。');

  // 心事.md 在哪：这一页最底下（开关页不再放路径了）
  const journalText = ui.h('span', 'mono', '');
  journalText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8';
  const copyJournalBtn = ui.copyButton(() => journalText.textContent || '');
  const journalBar = ui.h('div', null, '');
  journalBar.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;max-width:100%';
  const journalLabel = ui.h('span', null, '心事.md');
  journalLabel.style.cssText = 'opacity:.6;white-space:nowrap;flex:none';
  journalBar.append(journalLabel, journalText, copyJournalBtn);

  sheet.body.append(
    ui.field('共几条', totalText),
    table.el,
    ui.field('提醒过的跟进多久清掉（分钟，5–1440）', staleInputBar),
    staleHint,
    ui.section('心事', '醒来的时候想想事情：翻一眼心事.md、挑个没答的问题写一条。'),
    ui.field('让我想', journalCheck.el),
    ui.field('时刻', wakeModeSeg.el),
    ui.field('自定义', timesBar),
    timesHint,
    journalBar,
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

  // ---- 心事三项的保存（跟上面的数字一样：改完自动存） ----
  let journalBusy = false;
  let timesTimer = 0;
  let lastTimes = null;

  async function saveJournal(patch) {
    if (journalBusy) return;
    journalBusy = true;
    try {
      const res = await ctx.invoke('save', [patch]);
      if (ctx.signal && ctx.signal.aborted) return;
      render(res);
      say('存好了。', false);
      ui.toast('存好了', 'ok');
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`没存上：${errText(err)}`, true);
      ui.toast('没存上', 'bad');
      if (lastTimes !== null && Object.prototype.hasOwnProperty.call(patch, 'wakeTimes')) {
        timesInput.value = lastTimes;
      }
    } finally {
      journalBusy = false;
    }
  }

  function syncTimes(quiet) {
    if (timesTimer) {
      clearTimeout(timesTimer);
      timesTimer = 0;
    }
    const raw = timesInput.value;
    if (raw === lastTimes) return;
    void saveJournal({ wakeTimes: raw });
  }

  timesInput.addEventListener('input', () => {
    if (timesTimer) clearTimeout(timesTimer);
    timesTimer = setTimeout(() => {
      timesTimer = 0;
      syncTimes(true);
    }, 800);
  });
  timesInput.addEventListener('change', () => syncTimes(false));
  timesInput.addEventListener('blur', () => syncTimes(true));

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

    // 心事三项（也在这一页，跟上面一样改完自动存）
    const journalOn = Boolean(res && res.journalOn === true);
    if (typeof journalCheck.setChecked === 'function') journalCheck.setChecked(journalOn);
    const mode = res && typeof res.wakeMode === 'string' ? res.wakeMode : 'quiet-end';
    if (typeof wakeModeSeg.setValue === 'function') wakeModeSeg.setValue(mode);
    const rawTimes = res && typeof res.wakeTimesRaw === 'string' ? res.wakeTimesRaw : '';
    lastTimes = rawTimes;
    if (typeof document === 'undefined' || document.activeElement !== timesInput) {
      timesInput.value = rawTimes;
    }
    timesInput.disabled = mode === 'quiet-end';
    const parsed = res && Array.isArray(res.wakeTimes) ? res.wakeTimes : [];
    timesHint.textContent =
      mode === 'quiet-end'
        ? '「时刻」现在按安静时段结束算，这里填的时间不会被用；想按钟点醒就把「时刻」切成自定义或两者。'
        : parsed.length
          ? `现在会在 ${parsed.join('、')} 醒（每个时间点一天醒一次，两次之间至少隔 20 分钟）。`
          : '还没填时间。写 0900 这种四位数，逗号隔开，例如 0900, 2130。';
    journalText.textContent = (res && typeof res.journal === 'string' && res.journal) || '';
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

// 面板「开关」：一行一个开关，右边是它现在的状态，下面紧跟着同一回事的细节。
// 条目顺序必须和用户要的顺序一致；key 照抄 world.ts 的 SWITCH_KEYS（那边按同一顺序排）。
const SWITCH_ROWS = [
  { key: 'watchActivity', label: '监测', hint: '看前台窗口。关掉后离开、回来、待久、落账都停，只剩到点提醒和戳摸。' },
  { key: 'lookEnabled', label: '看一眼', hint: '隔一阵主动看一眼屏幕。多久一次在设置页「看一眼屏幕」里填。' },
  { key: 'screenshot', label: '截图', hint: '递由头时顺手带一张屏幕截图（模型能看图时）。' },
  { key: 'pokeNudge', label: '连戳两下', hint: '连戳桌宠两下，就递一条由头。' },
  { key: 'companion', label: '连摸两下', hint: '连摸桌宠两下，接下来陪你说几眼。' },
  { key: 'backNudge', label: '欢迎回来', hint: '离开一阵子再回来，打声招呼。' },
  { key: 'relayAway', label: '离开时转 QQ', hint: '人不在的时候，桌宠冒的泡抄一份发到 QQ。' },
  { key: 'relayAlways', label: '全程转 QQ', hint: '开着就全程抄送，上面那条「离开时」就不起作用了。' },
];

// 卡片顶部那行标题是宿主 ui.sheet() 无条件塞进来的 <h3>（里面还藏着 note 小标签），
// 传空字符串也只是留个空行。想要「没有标题」就得自己把它藏掉——不碰宿主 CSS。
function hideHeading(sheet) {
  const head = sheet && sheet.el && sheet.el.firstElementChild;
  if (head && head.style) head.style.display = 'none';
}

// 宿主的表格是 auto 布局：列宽由内容撑。拨一下开关后状态文字变长、跨三列的灰字行换行，
// 都会让浏览器重新分列宽——看起来就是「后面两栏往右移」。钉死列宽就没有这个问题了。
function lockColumns(table, widths) {
  const tbl = table && table.el && table.el.firstElementChild;
  if (!tbl || !tbl.style) return;
  tbl.style.tableLayout = 'fixed';
  tbl.style.width = '100%';
  const doc = tbl.ownerDocument;
  if (!doc || typeof doc.createElement !== 'function') return;
  const colgroup = doc.createElement('colgroup');
  for (const w of widths) {
    const col = doc.createElement('col');
    if (w) col.style.width = w;
    colgroup.appendChild(col);
  }
  tbl.insertBefore(colgroup, tbl.firstChild);
}

function mountSwitches(ctx) {
  const ui = ctx.ui;
  const sheet = ui.sheet({ title: '' });
  hideHeading(sheet);

  const message = ui.msgline('');
  const table = ui.table({ head: ['开关', '拨一下', '现在'] });
  // 名字一栏按比例，勾一栏刚好放得下，剩下的都给状态那句
  lockColumns(table, ['40%', '96px', '']);
  const boxes = new Map();
  const statuses = new Map();
  // 同一个开关下面的细节行：key -> 元素数组（按顺序填）
  const details = { watch: [], companion: [] };

  function say(text, bad) {
    message.textContent = text || '';
    message.classList.toggle('bad', Boolean(bad));
  }

  // 细节行：跨三列的一行小灰字，挂在它上面那个开关后面
  function detailRow(bucket) {
    const line = ui.h('div', null, '');
    line.style.cssText = 'font-size:12px;opacity:.55;line-height:1.5;white-space:pre-wrap';
    const tr = table.addRow([line]);
    const td = tr && tr.cells && tr.cells[0];
    if (td) td.colSpan = 3;
    bucket.push(line);
    return line;
  }

  function switchRow(row) {
    const name = ui.h('span', null, row.label);
    name.title = row.hint;
    const box = ui.checkbox('', {
      title: row.hint,
      onChange: (checked) => void save(row.key, checked),
    });
    // 宿主表格里的勾走通用规则：16×16、圆角 4px、勾图 12px。那条选择器全是 :where()，
    // 特异性只有一层，写成行内样式就压得住，不用 !important，也不用改宿主 CSS。
    box.input.style.width = '20px';
    box.input.style.height = '20px';
    box.input.style.borderRadius = '5px';
    box.input.style.backgroundSize = '15px 15px';
    boxes.set(row.key, box);
    const status = ui.h('span', null, '');
    status.style.cssText = 'opacity:.7;font-size:12px';
    statuses.set(row.key, status);
    table.addRow([name, box.el, status]);
    return box;
  }

  for (const row of SWITCH_ROWS) {
    switchRow(row);
    if (row.key === 'watchActivity') {
      // 前台是哪个程序、几分钟没碰键鼠、连着多久同一件事——不在这儿显示了，
      // 只留最近一小时这条概览
      detailRow(details.watch);
    } else if (row.key === 'companion') {
      detailRow(details.companion);
    }
  }

  const stats = ui.h('div', null, '');
  stats.style.cssText = 'font-size:12px;opacity:.55;margin-top:8px';

  // 最底下留个说话的地方：有问题、有想法直接发这个邮箱。
  // 邮箱写成常量，复制按钮和显示用的是同一份，别改一处忘一处。
  const feedbackText = ui.h('span', null, '');
  feedbackText.style.cssText = 'font-size:12px;opacity:.55';
  feedbackText.textContent = `反馈渠道：${FEEDBACK_EMAIL}`;
  const copyFeedbackBtn = ui.button('复制邮箱', {
    size: 'sm',
    onClick: () => void copyPath(FEEDBACK_EMAIL, copyFeedbackBtn),
  });
  const feedbackBar = ui.rowbar();
  feedbackBar.append(feedbackText, copyFeedbackBtn);

  sheet.body.append(table.el, stats, feedbackBar, message);

  function fill(els, texts) {
    els.forEach((el, i) => {
      const text = texts[i] || '';
      el.textContent = text;
      el.hidden = !text;
    });
  }

  // 一个勾现在的说明：被别的开关架住时换成那句原因，否则用默认提示
  function hintOf(key, locked, lockReason) {
    if (locked && lockReason) return lockReason;
    const row = SWITCH_ROWS.find((r) => r.key === key);
    return (row && row.hint) || '';
  }

  function render(res) {
    const list = Array.isArray(res && res.switches) ? res.switches : [];
    for (const item of list) {
      const box = boxes.get(item.key);
      if (box) {
        box.setChecked(item.on === true);
        // 服务端说这一项现在用不上（比如监测关着时的「看前台」「欢迎回来」）：
        // 勾置灰、按不动，鼠标停上去说明为什么。值不重置，回头开监测还在。
        const locked = item.locked === true;
        box.input.disabled = locked;
        box.el.title = hintOf(item.key, locked, item.lockReason);
        box.el.style.opacity = locked ? '.45' : '';
      }
      const status = statuses.get(item.key);
      if (status) status.textContent = item.status || '';
    }
    const info = (res && res.info) || {};
    const watch = info.watch || {};
    fill(details.watch, [watch.recent || '']);
    fill(details.companion, [(info.companion && info.companion.state) || '']);
    const s = (res && res.stats) || {};
    stats.textContent = `今天说了 ${s.saidToday || 0} 条 · 最近一小时 ${s.saidLastHour || 0} 条 · 暂存 ${s.pending || 0} 条`;
    // 「全程转 QQ」开着时，「离开时转 QQ」的勾会失效：把它标出来，别让人以为坏了
    const alwaysBox = boxes.get('relayAlways');
    const awayBox = boxes.get('relayAway');
    if (alwaysBox && awayBox) {
      const off = alwaysBox.checked;
      awayBox.input.disabled = off;
      awayBox.el.title = off ? '「全程转 QQ」开着，这条暂时用不上' : SWITCH_ROWS.find((r) => r.key === 'relayAway').hint;
    }
  }

  async function save(key, checked) {
    const box = boxes.get(key);
    try {
      const res = await ctx.invoke('save', [{ [key]: checked }]);
      if (ctx.signal && ctx.signal.aborted) return;
      render(res);
      say(checked ? '开了' : '关了', false);
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      if (box) box.setChecked(!checked);
      say(`没存上：${errText(err)}`, true);
    }
  }

  async function refresh() {
    try {
      const res = await ctx.invoke('list');
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
  ctx.root.appendChild(sheet.el);
}

const bundle = { panels: { pending: { mount: mountPending }, switches: { mount: mountSwitches } } };

export { bundle as default };
