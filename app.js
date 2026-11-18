/* =====================================================================
 *  app.js — 화면, 입력, Supabase 연동
 * ===================================================================*/
(function () {
  'use strict';
  const C = window.TodoCore;
  const CFG = window.TODO_CONFIG;
  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } },
  };
  const today = () => C.todayYmd();
  const catKey = c => (c || '기타').slice(0, 2).replace('/', '');

  const S = {
    tasks: [], subs: [],
    expanded: new Set(LS.get('todo.expanded', [])),
    view: 'all', project: '', q: '', tab: 'todo',
    showRoutineDone: LS.get('todo.showRoutineDone', false),
    lastCat: LS.get('todo.lastCat', '제안/협의'),
    lastCreatedId: null, loadedAt: 0, sortables: [],
  };
  const pending = new Map();   // 삭제 대기(되돌리기용)

  /* 완료 피드백: 업무용 톤에 맞춰 시각 효과 없이 토스트만 사용 */
  const cheer = () => {};
  const burst = () => {};
  const idleTalk = () => {};

  /* =================== 토스트 / 모달 =================== */
  let toastTimer = null;
  function toast(msg, opt = {}) {
    $('.toast')?.remove(); clearTimeout(toastTimer);
    const el = document.createElement('div');
    el.className = `toast pbox${opt.err ? ' err' : ''}`;
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (opt.action) {
      const b = document.createElement('button'); b.className = 'pbtn small'; b.textContent = opt.action;
      b.onclick = () => { el.remove(); opt.onAction(); }; el.appendChild(b);
    }
    document.body.appendChild(el);
    toastTimer = setTimeout(() => el.remove(), opt.ms || 3500);
  }
  const fail = (e, msg = '저장 실패') => { console.error(e); toast(`${msg}: ${e?.message || e}`, { err: true, ms: 6000 }); };

  function openModal(title, bodyHTML, footHTML = '') {
    closeModal();
    const d = document.createElement('div'); d.className = 'dim'; d.id = 'dim';
    d.innerHTML = `<div class="modal pbox" role="dialog"><h3>${title}<button class="pbtn small x" data-close>✕</button></h3>
      <div class="body">${bodyHTML}</div>${footHTML ? `<div class="foot">${footHTML}</div>` : ''}</div>`;
    d.addEventListener('mousedown', e => { if (e.target === d) closeModal(); });
    d.querySelector('[data-close]').onclick = closeModal;
    document.body.appendChild(d);
    return d;
  }
  function closeModal() { $('#dim')?.remove(); }

  /* =================== 데이터 =================== */
  const taskById = id => S.tasks.find(t => t.id === id);
  const subById = id => S.subs.find(s => s.id === id);
  const subsOf = id => S.subs.filter(s => s.task_id === id).sort(C.bySort);

  async function loadAll() {
    const [t, s] = await Promise.all([
      sb.from('tasks').select('*').order('sort_order'),
      sb.from('subtasks').select('*').order('sort_order'),
    ]);
    if (t.error) return fail(t.error, '불러오기 실패');
    if (s.error) return fail(s.error, '불러오기 실패');
    S.tasks = t.data; S.subs = s.data; S.loadedAt = Date.now();
    render(); idleTalk();
  }

  async function patch(kind, id, fields) {
    const tbl = kind === 'task' ? 'tasks' : 'subtasks';
    const obj = kind === 'task' ? taskById(id) : subById(id);
    if (!obj) return null;
    Object.assign(obj, fields);
    const { data, error } = await sb.from(tbl).update(fields).eq('id', id).select().single();
    if (error) { fail(error); return null; }
    Object.assign(obj, data);
    return obj;
  }

  const groupOf = cat => (cat === '상시' ? 'alw' : 'pri');
  const maxSort = list => list.reduce((m, x) => Math.max(m, x.sort_order), 0);

  async function createTask(fields = {}, focus = true) {
    const category = C.normCat(fields.category) || S.lastCat || '기타';
    const grp = S.tasks.filter(t => !t.done && groupOf(t.category) === groupOf(category));
    const row = {
      category, project: fields.project ?? (S.project || ''), title: fields.title || '', note: fields.note || '',
      start_date: fields.start_date || null, due_date: fields.due_date || null,
      sort_order: Math.floor(maxSort(grp)) + 1,
    };
    const { data, error } = await sb.from('tasks').insert(row).select().single();
    if (error) { fail(error); return null; }
    S.tasks.push(data); S.lastCreatedId = data.id;
    render();
    if (focus) focusField('task', data.id, 'title');
    return data;
  }

  async function addSub(taskId, fields = {}, focus = true) {
    const row = {
      task_id: taskId, title: fields.title || '', start_date: fields.start_date || null, due_date: fields.due_date || null,
      sort_order: Math.floor(maxSort(subsOf(taskId))) + 1,
    };
    const { data, error } = await sb.from('subtasks').insert(row).select().single();
    if (error) { fail(error); return null; }
    S.subs.push(data); S.expanded.add(taskId); saveExpanded();
    render();
    if (focus) focusField('sub', data.id, 'title');
    return data;
  }

  async function toggleTask(id, srcEl) {
    const t = taskById(id); if (!t) return;
    const nd = !t.done;
    if (nd) {
      if (srcEl) burst(srcEl);
      cheer();
      const el = $(`.task[data-id="${id}"]`);
      if (el && S.tab === 'todo') { el.classList.add('completing'); await sleep(430); }
    }
    t.done = nd; t.completed_at = nd ? new Date().toISOString() : null;
    render(); renderStats();
    const r = await patch('task', id, { done: nd, completed_at: null });
    if (r && nd) toast('완료함으로 이동했어요', { action: '되돌리기', onAction: () => toggleTask(id) });
    render(); renderStats();
  }

  async function toggleSub(id, srcEl) {
    const s = subById(id); if (!s) return;
    const nd = !s.done;
    if (nd && srcEl) burst(srcEl);
    s.done = nd; s.completed_at = nd ? new Date().toISOString() : null;
    render(); renderStats();
    await patch('sub', id, { done: nd, completed_at: null });
    renderStats();
  }

  /* 삭제: 화면에서 먼저 빼고 5초 뒤 실제 삭제 (그 사이 되돌리기 가능) */
  function deleteLater(kind, id) {
    const key = `${kind}:${id}`;
    const snap = kind === 'task'
      ? { t: taskById(id), subs: subsOf(id) }
      : { s: subById(id) };
    if (kind === 'task') { S.tasks = S.tasks.filter(t => t.id !== id); S.subs = S.subs.filter(s => s.task_id !== id); }
    else S.subs = S.subs.filter(s => s.id !== id);
    render(); renderStats();
    const run = async () => {
      pending.delete(key);
      const { error } = await sb.from(kind === 'task' ? 'tasks' : 'subtasks').delete().eq('id', id);
      if (error) fail(error, '삭제 실패');
    };
    pending.set(key, { timer: setTimeout(run, 5000), run });
    toast(kind === 'task' ? '작업을 삭제했어요' : '하위작업을 삭제했어요', {
      action: '되돌리기', ms: 5000,
      onAction: () => {
        const p = pending.get(key); if (!p) return;
        clearTimeout(p.timer); pending.delete(key);
        if (kind === 'task') { S.tasks.push(snap.t); S.subs.push(...snap.subs); } else S.subs.push(snap.s);
        render(); renderStats();
      },
    });
  }
  function flushDeletes() { for (const p of [...pending.values()]) { clearTimeout(p.timer); p.run(); } }

  /* 정렬값 재계산 */
  async function reorder(kind, ids, movedId) {
    const get = kind === 'task' ? taskById : subById;
    const arr = ids.map(get).filter(Boolean);
    const i = arr.findIndex(x => x.id === movedId);
    const prev = arr[i - 1], next = arr[i + 1];
    let so;
    if (prev && next) so = (prev.sort_order + next.sort_order) / 2;
    else if (prev) so = prev.sort_order + 1;
    else if (next) so = next.sort_order - 1;
    else return;
    if ((prev && Math.abs(so - prev.sort_order) < 1e-6) || (next && Math.abs(so - next.sort_order) < 1e-6)) {
      // 간격이 너무 좁아지면 전체 재번호
      arr.forEach((x, k) => { x.sort_order = k + 1; });
      await Promise.all(arr.map(x => sb.from(kind === 'task' ? 'tasks' : 'subtasks').update({ sort_order: x.sort_order }).eq('id', x.id)));
      render(); return;
    }
    await patch(kind, movedId, { sort_order: so });
    render();
  }
  async function moveRow(kind, id, dir) {
    if (S.view !== 'all' || S.q || S.project) return toast('필터를 해제해야 순서를 바꿀 수 있어요');
    let ids;
    if (kind === 'task') {
      const t = taskById(id);
      ids = S.tasks.filter(x => !x.done && groupOf(x.category) === groupOf(t.category)).sort(C.bySort).map(x => x.id);
    } else ids = subsOf(subById(id).task_id).map(x => x.id);
    const i = ids.indexOf(id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await reorder(kind, ids, id);
    focusField(kind, id, document.activeElement?.dataset?.f || 'title');
  }

  /* =================== 필터 =================== */
  function textMatch(t) {
    if (!S.q) return true;
    const q = S.q.toLowerCase();
    const hay = [t.title, t.project, t.note, t.category].concat(subsOf(t.id).map(s => s.title)).join(' ').toLowerCase();
    return hay.includes(q);
  }
  function viewMatch(t) {
    if (S.view === 'all') return true;
    const td = today(), w = C.weekInfo(new Date());
    const dates = [t].concat(subsOf(t.id).filter(s => !s.done)).map(x => x.due_date).filter(Boolean);
    if (S.view === 'overdue') return C.isOverdue(t, td) || subsOf(t.id).some(s => C.isOverdue(s, td));
    if (S.view === 'today') return dates.some(d => d <= td);
    if (S.view === 'week') return dates.some(d => d <= w.sunYmd);
    return true;
  }
  const filtered = () => !!(S.q || S.project || S.view !== 'all');

  /* =================== 렌더링 =================== */
  function dateBtn(it) {
    const td = today();
    const txt = C.dateCellText(it.start_date, it.due_date);
    let chip = '';
    if (it.due_date && !it.done) {
      const n = C.dday(it.due_date, td);
      const cls = n < 0 ? 'over' : n === 0 ? 'today' : n <= 3 ? 'soon' : '';
      chip = `<span class="dd ${cls}">${C.ddayLabel(n)}</span>`;
    }
    return `<button class="datebtn" data-act="date" title="클릭하면 달력이 열려요 (기간은 ⋯ 상세에서)">${txt ? `<span class="dtxt">${esc(txt)}</span>` : '<span class="dtxt ph">날짜</span>'}${chip}</button>`;
  }

  function taskHTML(t, nums) {
    const td = today();
    const subs = subsOf(t.id);
    const exp = S.expanded.has(t.id) || (S.q && subs.some(s => (s.title || '').toLowerCase().includes(S.q.toLowerCase())));
    const doneCnt = subs.filter(s => s.done).length;
    const num = t.category === '상시' ? '-' : (nums[t.id] ?? '');
    const subLabel = subs.length ? `${exp ? '▾' : '▸'} ${doneCnt}/${subs.length}` : '＋';
    return `<div class="task" data-id="${t.id}">
      <div class="row main cols cat-${catKey(t.category)}${C.isOverdue(t, td) ? ' overdue' : ''}" data-kind="task" data-id="${t.id}">
        <span class="handle" title="드래그로 순서 변경">⠿</span>
        <button class="chk" data-act="toggle" title="완료 (Ctrl+Enter)" aria-label="완료"></button>
        <span class="no">${num}</span>
        ${dateBtn(t)}
        <input class="f-project" data-f="project" list="dl-projects" value="${esc(t.project)}" placeholder="프로젝트" title="${esc(t.project)}">
        <input class="f-cat" data-f="category" list="dl-cats" value="${esc(t.category)}" placeholder="업무구분">
        <input class="f-title" data-f="title" value="${esc(t.title)}" placeholder="작업 내용" title="${esc(t.title)}">
        <input class="f-note" data-f="note" value="${esc(t.note)}" placeholder="비고" title="${esc(t.note)}">
        <button class="subtog${subs.length ? ' has' : ''}" data-act="subs" title="하위작업 (Shift+Enter로 추가)">${subLabel}</button>
        <button class="more" data-act="more" title="상세 편집">⋯</button>
      </div>
      ${exp ? `<div class="subs-box"><div class="subs" data-parent="${t.id}">${subs.map((s, i) => subHTML(s, i)).join('')}</div>
        <button class="addsub" data-act="addsub" data-id="${t.id}">＋ 하위작업 추가 <span class="kbd">Shift+Enter</span></button></div>` : ''}
    </div>`;
  }

  function subHTML(s, i) {
    const td = today();
    return `<div class="row sub cols${s.done ? ' done' : ''}${C.isOverdue(s, td) ? ' overdue' : ''}" data-kind="sub" data-id="${s.id}">
      <span class="handle" title="드래그">⠿</span>
      <button class="chk${s.done ? ' on' : ''}" data-act="toggle" aria-label="완료"></button>
      <span class="no">${C.roman(i + 1)}.</span>
      ${dateBtn(s)}
      <div class="sub-title"><input data-f="title" value="${esc(s.title)}" placeholder="하위작업 내용" title="${esc(s.title)}"></div>
      <span class="subpad"></span>
      <button class="xbtn" data-act="delsub" title="삭제 (Ctrl+Delete)">✕</button>
    </div>`;
  }

  function captureFocus() {
    const a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.f) return null;
    const row = a.closest('.row'); if (!row) return null;
    return { kind: row.dataset.kind, id: row.dataset.id, f: a.dataset.f, s: a.selectionStart, e: a.selectionEnd, v: a.value };
  }
  function restoreFocus(fc) {
    if (!fc) return;
    const inp = $(`.row[data-kind="${fc.kind}"][data-id="${fc.id}"] [data-f="${fc.f}"]`);
    if (!inp) return;
    const combo = fc.f === 'project' || fc.f === 'category';
    if (!combo && inp.value !== fc.v) inp.value = fc.v;  // 저장 전 입력값 보존
    inp.focus({ preventScroll: true });                 // (프로젝트·업무구분 칸은 focusin에서 비워짐)
    if (combo && fc.v) inp.value = fc.v;
    try { inp.setSelectionRange(fc.s, fc.e); } catch { /* noop */ }
  }
  function focusField(kind, id, f) {
    requestAnimationFrame(() => {
      const inp = $(`.row[data-kind="${kind}"][data-id="${id}"] [data-f="${f}"]`) || $(`.row[data-kind="${kind}"][data-id="${id}"] [data-f="title"]`);
      if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); }
    });
  }

  function render() {
    const fc = captureFocus();
    $$('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    $('#todo-view').hidden = S.tab !== 'todo';
    $('#done-view').hidden = S.tab !== 'done';
    $('#viewbtns').style.display = S.tab === 'todo' ? '' : 'none';
    $('#routine-toggle').style.display = S.tab === 'done' ? '' : 'none';
    $$('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
    renderDatalists();
    if (S.tab === 'todo') renderTodo(); else renderDone();
    renderStats();
    restoreFocus(fc);
  }

  function renderTodo() {
    const nums = C.computeNumbers(S.tasks);
    const act = S.tasks.filter(t => !t.done);
    const vis = act.filter(t => (!S.project || t.project === S.project) && textMatch(t) && viewMatch(t));
    const pri = vis.filter(t => t.category !== '상시').sort(C.bySort);
    const alw = vis.filter(t => t.category === '상시').sort(C.bySort);
    const emptyMsg = filtered() ? '조건에 맞는 작업이 없어요' : '비어 있어요! 위 입력창에서 할 일을 추가해 보세요';
    $('#list-pri').innerHTML = pri.map(t => taskHTML(t, nums)).join('') || `<div class="empty">${emptyMsg}</div>`;
    $('#list-alw').innerHTML = alw.map(t => taskHTML(t, nums)).join('') || `<div class="empty">상시 작업 없음</div>`;
    $('#cnt-pri').textContent = `${pri.length}건`;
    $('#cnt-alw').textContent = `${alw.length}건`;
    $('#cnt-todo').textContent = act.length ? `(${act.length})` : '';
    $('.board').classList.toggle('drag-off', filtered());
    setupSortables();
  }

  function setupSortables() {
    S.sortables.forEach(s => s.destroy()); S.sortables = [];
    if (!window.Sortable || filtered()) return;
    const common = { handle: '.handle', animation: 120, ghostClass: 'sortable-ghost', delay: 120, delayOnTouchOnly: true };
    ['#list-pri', '#list-alw'].forEach(sel => {
      S.sortables.push(Sortable.create($(sel), Object.assign({}, common, {
        group: sel, draggable: '.task',
        onEnd: e => { if (e.oldIndex !== e.newIndex) reorder('task', [...e.to.children].map(c => c.dataset.id).filter(Boolean), e.item.dataset.id); },
      })));
    });
    $$('.subs').forEach(box => {
      S.sortables.push(Sortable.create(box, Object.assign({}, common, {
        group: `subs-${box.dataset.parent}`, draggable: '.row.sub',
        onEnd: e => { if (e.oldIndex !== e.newIndex) reorder('sub', [...e.to.children].map(c => c.dataset.id), e.item.dataset.id); },
      })));
    });
  }

  function renderDone() {
    const q = S.q.toLowerCase();
    const list = S.tasks.filter(t => t.done && t.completed_at
      && (S.showRoutineDone || !t.routine_id)
      && (!S.project || t.project === S.project) && textMatch(t))
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at));
    if (!list.length) { $('#done-view').innerHTML = `<div class="pbox empty">${q ? '검색 결과가 없어요' : '아직 완료한 작업이 없어요'}</div>`; return; }
    const groups = new Map();
    for (const t of list) {
      const w = C.weekInfo(new Date(t.completed_at));
      if (!groups.has(w.monYmd)) groups.set(w.monYmd, { w, items: [] });
      groups.get(w.monYmd).items.push(t);
    }
    let h = '';
    for (const { w, items } of groups.values()) {
      h += `<div class="weekblk pbox"><div class="weekhead">${w.month}월 ${w.week}주차 <span class="r">${C.mmdd(w.monYmd)} ~ ${C.mmdd(w.sunYmd)}</span><span class="n">${items.length}건</span></div>`;
      for (const t of items) {
        const subs = subsOf(t.id);
        h += `<div class="drow" data-id="${t.id}">
          <button class="chk on" data-act="restore" title="체크 해제 = 할 일로 복귀"></button>
          <input type="date" data-act="cdate" value="${C.tsYmd(t.completed_at)}" title="완료일 수정">
          <span class="dcat"><span class="chip c-${catKey(t.category)}">${esc(t.category)}</span></span>
          <span class="dproj" title="${esc(t.project)}">${esc(t.project)}</span>
          <span class="t" title="${esc(t.title)}">${esc(t.title)} <span style="color:var(--text3);font-weight:400">${esc(C.rangeText(t.start_date, t.due_date))}</span></span>
          <button class="xbtn" data-act="deldone" title="삭제">✕</button>
        </div>`;
        subs.forEach((s, i) => { h += `<div class="dsub${s.done ? ' ok' : ''}"><span title="${esc(s.title)}">${C.roman(i + 1)}. ${esc(s.title)}${s.done ? ' ✓' : ''}</span></div>`; });
      }
      h += '</div>';
    }
    $('#done-view').innerHTML = h;
  }

  function renderStats() {
    const td = today(), now = new Date();
    const act = S.tasks.filter(t => !t.done);
    const over = act.filter(t => C.isOverdue(t, td)).length + S.subs.filter(s => C.isOverdue(s, td) && taskById(s.task_id) && !taskById(s.task_id).done).length;
    const due = act.filter(t => t.due_date === td).length;
    const ws = C.weekStats(S.tasks, S.subs, now), st = C.streak(S.tasks, S.subs, now);
    $('#stats').innerHTML = `
      <div class="stat${due ? ' accent' : ''}"><span class="k">오늘 마감</span><b>${due}</b><span class="u">건</span></div>
      <div class="stat${over ? ' warn' : ''}"><span class="k">지연</span><b>${over}</b><span class="u">건</span></div>
      <div class="stat"><span class="k">이번 주 완료</span><b>${ws.main}</b><span class="u">건<span class="x"> · 하위 ${ws.sub}</span></span></div>
      <div class="stat" title="평일 기준 연속으로 완료 기록이 있는 날"><span class="k">연속 완료</span><b>${st}</b><span class="u">일</span></div>`;
    const W = '일월화수목금토';
    $('#weeklabel').textContent = `${C.weekLabel(now)} · ${now.getMonth() + 1}월 ${now.getDate()}일 (${W[now.getDay()]})`;
  }

  function renderDatalists() {
    const seen = new Map();
    [...S.tasks].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .forEach(t => { const p = (t.project || '').trim(); if (p && !seen.has(p)) seen.set(p, 1); });
    const projects = [...seen.keys()];
    $('#dl-projects').innerHTML = projects.map(p => `<option value="${esc(p)}">`).join('');
    const sel = $('#f-project'), cur = S.project;
    sel.innerHTML = '<option value="">전체 프로젝트</option>' + [...projects].sort((a, b) => a.localeCompare(b, 'ko')).map(p => `<option${p === cur ? ' selected' : ''}>${esc(p)}</option>`).join('');
  }

  /* =================== 셀 편집 =================== */
  async function commit(inp) {
    const row = inp.closest('.row'); if (!row) return;
    const kind = row.dataset.kind, id = row.dataset.id, f = inp.dataset.f;
    const obj = kind === 'task' ? taskById(id) : subById(id); if (!obj) return;
    let v = inp.value;
    if (f === 'project' || f === 'category') {
      if (v.trim() === '' && inp.dataset.cleared !== '1') { inp.value = obj[f] || ''; return; }
      v = v.trim();
    }
    if (f === 'category') {
      const c = C.normCat(v);
      if (!c) { inp.value = obj.category; toast('업무구분은 상시 · 제안/협의 · 운영/관리 · 기타 중 하나예요'); return; }
      v = c; inp.value = c;
    }
    if ((obj[f] ?? '') === v) return;
    if (f === 'category') { S.lastCat = v; LS.set('todo.lastCat', v); }
    await patch(kind, id, { [f]: v });
    if (f === 'category' || f === 'project') render();
  }

  /* 프로젝트·업무구분 칸: 포커스하면 비워서 드롭다운 전체 노출, 그냥 나가면 원래 값 복원 */
  function onFocusIn(e) {
    const inp = e.target;
    if (!inp.matches?.('.row [data-f="project"], .row [data-f="category"]')) return;
    inp.dataset.orig = inp.value; inp.dataset.cleared = '';
    inp.placeholder = inp.value || (inp.dataset.f === 'project' ? '프로젝트' : '업무구분');
    inp.value = '';
  }
  function onFocusOut(e) {
    const inp = e.target;
    if (!inp.matches?.('.row [data-f="project"], .row [data-f="category"]')) return;
    if (inp.value === '' && inp.dataset.cleared !== '1') inp.value = inp.dataset.orig || '';
    inp.placeholder = inp.dataset.f === 'project' ? '프로젝트' : '업무구분';
  }

  function visibleRows() { return $$('#todo-view .row'); }
  function moveVert(row, f, dir, createAtEnd) {
    const rows = visibleRows(), i = rows.indexOf(row);
    const kind = row.dataset.kind;
    if (createAtEnd && dir > 0 && kind === 'sub') {
      const s = subById(row.dataset.id), list = subsOf(s.task_id);
      if (list[list.length - 1]?.id === s.id) return addSub(s.task_id);
    }
    const nx = rows[i + dir];
    if (!nx) {
      if (createAtEnd && dir > 0 && kind === 'task') { const t = taskById(row.dataset.id); return createTask({ category: t.category, project: t.project }); }
      return;
    }
    const target = nx.querySelector(`[data-f="${f}"]`) || nx.querySelector('[data-f="title"]');
    target?.focus();
  }

  function onListKey(e) {
    const inp = e.target.closest?.('input[data-f]'); if (!inp) return;
    if (e.isComposing || e.keyCode === 229) return;
    const row = inp.closest('.row'); const kind = row.dataset.kind, id = row.dataset.id, f = inp.dataset.f;
    if ((e.key === 'Backspace' || e.key === 'Delete') && inp.value === '') inp.dataset.cleared = '1';
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(inp); return kind === 'task' ? toggleTask(id, row.querySelector('.chk')) : toggleSub(id, row.querySelector('.chk')); }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); commit(inp); return addSub(kind === 'task' ? id : subById(id).task_id); }
    if (e.key === 'Enter' && (f === 'project' || f === 'category')) {
      // 드롭다운(datalist)에서 고른 값이 먼저 반영되도록 한 박자 늦게 처리
      return setTimeout(() => { commit(inp); moveVert(row, f, 1, true); }, 0);
    }
    if (e.key === 'Enter') { e.preventDefault(); commit(inp); return moveVert(row, f, 1, true); }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); commit(inp); return moveRow(kind, id, e.key === 'ArrowUp' ? -1 : 1); }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (f === 'title' || f === 'note')) { e.preventDefault(); commit(inp); return moveVert(row, f, e.key === 'ArrowUp' ? -1 : 1, false); }
    if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return deleteLater(kind, id); }
    if (e.key === 'Escape') {
      const obj = kind === 'task' ? taskById(id) : subById(id);
      if (f === 'project' || f === 'category') inp.dataset.cleared = '';
      inp.value = f === 'project' || f === 'category' ? '' : (obj[f] || '');
      inp.blur();
    }
  }

  async function onListClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('.row'); const kind = row?.dataset.kind, id = row?.dataset.id;
    switch (b.dataset.act) {
      case 'toggle': return kind === 'task' ? toggleTask(id, b) : toggleSub(id, b);
      case 'date': return openDatePicker(kind, id, b);
      case 'subs': {
        const tid = id;
        if (!subsOf(tid).length) return addSub(tid);
        S.expanded.has(tid) ? S.expanded.delete(tid) : S.expanded.add(tid); saveExpanded(); return render();
      }
      case 'addsub': return addSub(b.dataset.id);
      case 'delsub': return deleteLater('sub', id);
      case 'more': return openDetail(id);
    }
  }
  const saveExpanded = () => LS.set('todo.expanded', [...S.expanded]);

  /* =================== 날짜 팝오버 =================== */
  /* 날짜 셀 클릭 → 브라우저 달력이 바로 열리고, 날짜를 고르는 즉시 마감일로 저장
     (기간 시작일은 ⋯ 상세 편집에서 설정. 달력의 '삭제'를 누르면 날짜 지움) */
  let dpCtx = null;
  function openDatePicker(kind, id, btn) {
    const obj = kind === 'task' ? taskById(id) : subById(id); if (!obj) return;
    const inp = $('#quickdate');
    const r = btn.getBoundingClientRect();
    Object.assign(inp.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    dpCtx = { kind, id };
    inp.value = obj.due_date || '';
    try { inp.showPicker(); } catch { inp.focus(); inp.click(); }
  }
  async function onQuickDateChange() {
    if (!dpCtx) return;
    const { kind, id } = dpCtx;
    const obj = kind === 'task' ? taskById(id) : subById(id); if (!obj) return;
    const due = $('#quickdate').value || null;
    if (due === (obj.due_date || null)) return;
    let start = obj.start_date || null;
    if (!due || (start && start >= due)) start = null;     // 기간이 뒤집히거나 날짜를 지우면 시작일도 해제
    await patch(kind, id, { start_date: start, due_date: due });
    render();
    $(`.row[data-kind="${kind}"][data-id="${id}"] .datebtn`)?.focus();
  }

  /* =================== 상세 편집 (⋯ / 모바일) =================== */
  function openDetail(id) {
    const t = taskById(id); if (!t) return;
    const body = `<div class="form">
      <label>업무구분</label><select id="d-cat">${C.CATS.map(c => `<option${c === t.category ? ' selected' : ''}>${c}</option>`).join('')}</select>
      <label>프로젝트</label><input id="d-project" list="dl-projects" value="${esc(t.project)}">
      <label>작업</label><input id="d-title" value="${esc(t.title)}">
      <label>날짜</label><div class="two"><input type="date" id="d-start" value="${t.start_date || ''}" title="시작(기간일 때만)"><input type="date" id="d-due" value="${t.due_date || ''}" title="마감"></div>
      <label>비고</label><input id="d-note" value="${esc(t.note)}">
      <label>업무보고</label><label style="font-weight:400"><input type="checkbox" id="d-report" style="width:auto;height:auto"${t.report_include ? ' checked' : ''}> 보고서에 포함</label>
    </div>`;
    const foot = `<button class="pbtn danger" id="d-del">삭제</button><span class="note">날짜 2개 = 기간(시작~마감)</span><button class="pbtn primary" id="d-save">저장</button>`;
    const d = openModal('작업 상세', body, foot);
    $('#d-title', d).focus();
    $('#d-del', d).onclick = () => { closeModal(); deleteLater('task', id); };
    const save = async () => {
      let s = $('#d-start', d).value || null, du = $('#d-due', d).value || null;
      if (s && !du) du = s; if (s && du && s > du) [s, du] = [du, s]; if (s === du) s = null;
      const f = {
        category: $('#d-cat', d).value, project: $('#d-project', d).value.trim(), title: $('#d-title', d).value,
        note: $('#d-note', d).value, start_date: s, due_date: du, report_include: $('#d-report', d).checked,
      };
      closeModal(); await patch('task', id, f); render(); idleTalk();
    };
    $('#d-save', d).onclick = save;
    d.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); save(); } });
  }

  /* =================== 업무보고 =================== */
  function openReport() {
    const now = new Date(), w = C.weekInfo(now);
    const txt = C.buildReport(S.tasks, S.subs, now);
    const nextSun = C.ymd(C.addDays(w.sun, 7));
    const d = openModal('주간 업무보고', `<textarea id="rep" spellcheck="false">${esc(txt)}</textarea>`,
      `<span class="note">금주 = ${C.mmdd(w.monYmd)}~${C.mmdd(w.sunYmd)} 완료분 · 차주 = ~${C.mmdd(nextSun)} 마감 미완료분 · 루틴 제외</span>
       <button class="pbtn primary" id="rep-copy">복사하기</button>`);
    $('#rep-copy', d).onclick = async () => {
      const v = $('#rep', d).value;
      try { await navigator.clipboard.writeText(v); } catch { $('#rep', d).select(); document.execCommand('copy'); }
      toast('업무보고를 클립보드에 복사했어요'); cheer();
    };
  }

  /* =================== 일괄 붙여넣기 =================== */
  function openBulk() {
    const body = `<p class="muted" style="margin:0 0 10px">
      한 줄 = 메인 작업 · 들여쓰기 / i. / • 로 시작 = 바로 위 작업의 하위작업 · @11/20, (11/09-12) 날짜 인식</p>
      <textarea id="bk-text" style="min-height:200px" placeholder="- 볼보그룹 OPS IW 교육운영 준비 @12/10
   i. 교육 운영 물품 구매 @11/21
   ii. 강사 컨택 및 사전설문 전달 @11/25
- 한미약품 제안서 송부 @11/20"></textarea>
      <div class="form" style="margin-top:10px">
        <label>기본 프로젝트</label><input id="bk-project" list="dl-projects" placeholder="(선택) 모든 메인 작업에 적용">
        <label>기본 업무구분</label><select id="bk-cat">${C.CATS.map(c => `<option${c === S.lastCat ? ' selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div id="bk-preview" style="margin-top:14px"></div>`;
    const d = openModal('일괄 입력', body,
      `<span class="note">미리보기에서 체크 해제·수정 후 추가</span><button class="pbtn" id="bk-parse">미리보기</button><button class="pbtn primary" id="bk-add" disabled>선택 항목 추가</button>`);
    let items = [];
    $('#bk-text', d).focus();
    $('#bk-parse', d).onclick = () => {
      items = C.parseBulk($('#bk-text', d).value, today());
      const pv = $('#bk-preview', d);
      if (!items.length) { pv.innerHTML = '<div class="empty">인식된 작업이 없어요</div>'; $('#bk-add', d).disabled = true; return; }
      pv.innerHTML = items.map((it, i) => `
        <div class="bulkrow"><input type="checkbox" data-i="${i}" checked><input type="text" data-i="${i}" value="${esc(it.title)}">
          <span class="d">${esc(C.dateCellText(it.start_date, it.due_date))}${it.project ? ` #${esc(it.project)}` : ''}</span></div>
        ${it.subs.map((s, j) => `<div class="bulkrow sub"><input type="checkbox" data-i="${i}" data-j="${j}" checked><input type="text" data-i="${i}" data-j="${j}" value="${esc(s.title)}">
          <span class="d">${esc(C.dateCellText(s.start_date, s.due_date))}</span></div>`).join('')}`).join('');
      $('#bk-add', d).disabled = false;
    };
    $('#bk-add', d).onclick = async () => {
      const pv = $('#bk-preview', d), defP = $('#bk-project', d).value.trim(), defC = $('#bk-cat', d).value;
      const val = (i, j) => pv.querySelector(`input[type=text][data-i="${i}"]${j == null ? ':not([data-j])' : `[data-j="${j}"]`}`).value.trim();
      const on = (i, j) => pv.querySelector(`input[type=checkbox][data-i="${i}"]${j == null ? ':not([data-j])' : `[data-j="${j}"]`}`).checked;
      $('#bk-add', d).disabled = true;
      let n = 0;
      for (let i = 0; i < items.length; i++) {
        if (!on(i)) continue;
        const it = items[i];
        const t = await createTask({ title: val(i), project: it.project || defP, category: it.category || defC, start_date: it.start_date, due_date: it.due_date }, false);
        if (!t) break; n++;
        for (let j = 0; j < it.subs.length; j++) {
          if (!on(i, j)) continue;
          await addSub(t.id, Object.assign({}, it.subs[j], { title: val(i, j) }), false); n++;
        }
      }
      closeModal(); render(); toast(`${n}개 항목을 추가했어요`); cheer();
    };
  }

  /* =================== 기타 =================== */
  function openHelp() {
    const rows = [
      ['Enter', '아래 행으로 이동 (마지막 행이면 새 작업/하위작업 추가)'],
      ['Shift + Enter', '하위작업 추가'], ['Ctrl + Enter', '완료 체크/해제'],
      ['Alt + ↑ / ↓', '행 순서 이동'], ['↑ / ↓', '작업·비고 칸에서 위아래 이동'],
      ['Tab / Shift+Tab', '칸 이동'], ['Ctrl + Delete', '행 삭제 (5초간 되돌리기)'],
      ['Esc', '편집 취소 / 창 닫기'], ['N', '빠른 입력으로 이동'], ['Ctrl + K  또는  /', '검색'],
      ['Alt + R', '업무보고 생성'], ['Alt + B', '일괄 붙여넣기'], ['?', '이 도움말'],
    ];
    openModal('단축키', `<dl class="helpgrid">${rows.map(([k, v]) => `<dt><span class="kbd">${k}</span></dt><dd style="margin:0">${v}</dd>`).join('')}</dl>
      <p class="muted" style="margin-top:16px">빠른 입력 토큰: @11/20 · @11/9-12 · @금 · @내일 · !운영 · #프로젝트_이름</p>`);
  }
  function backup() {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), tasks: S.tasks, subtasks: S.subs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `todo-backup-${today()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('백업 파일을 내려받았어요');
  }

  async function onQuickSubmit(e, asSub) {
    e?.preventDefault();
    const raw = $('#q-title').value.trim(); if (!raw) return;
    const q = C.parseQuick(raw, today());
    if (!q.title) return;
    if (asSub) {
      const parent = S.lastCreatedId && taskById(S.lastCreatedId);
      if (!parent) return toast('먼저 메인 작업을 하나 추가해 주세요');
      await addSub(parent.id, q, false);
    } else {
      const p = q.project ?? $('#q-project').value.trim();
      await createTask({ title: q.title, project: p, category: q.category || $('#q-cat').value, start_date: q.start_date, due_date: q.due_date }, false);
      if (q.project) $('#q-project').value = q.project;
    }
    $('#q-title').value = '';
    $('#q-title').focus();
  }

  /* =================== 이벤트 연결 =================== */
  function bind() {
    const tv = $('#todo-view');
    tv.addEventListener('click', onListClick);
    tv.addEventListener('keydown', onListKey);
    tv.addEventListener('change', e => { if (e.target.matches('input[data-f]')) commit(e.target); });
    tv.addEventListener('focusin', onFocusIn);
    tv.addEventListener('focusout', onFocusOut);

    $('#done-view').addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.closest('.drow')?.dataset.id;
      if (b.dataset.act === 'restore') { await toggleTask(id); toast('할 일로 되돌렸어요'); }
      if (b.dataset.act === 'deldone') deleteLater('task', id);
    });
    $('#done-view').addEventListener('change', async e => {
      if (e.target.dataset.act !== 'cdate' || !e.target.value) return;
      const id = e.target.closest('.drow').dataset.id;
      await patch('task', id, { completed_at: new Date(`${e.target.value}T18:00:00`).toISOString() });
      render(); toast('완료일을 수정했어요 (주차 재분류됨)');
    });

    $$('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
    $$('[data-view]').forEach(b => b.onclick = () => { S.view = b.dataset.view; render(); });
    $('#show-routine').checked = S.showRoutineDone;
    $('#show-routine').onchange = e => { S.showRoutineDone = e.target.checked; LS.set('todo.showRoutineDone', S.showRoutineDone); render(); };
    $('#f-project').onchange = e => { S.project = e.target.value; render(); };
    let st; $('#search').oninput = e => { clearTimeout(st); st = setTimeout(() => { S.q = e.target.value.trim(); render(); }, 150); };
    $('#search').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; S.q = ''; render(); e.target.blur(); } };

    $('#q-cat').innerHTML = C.CATS.map(c => `<option${c === S.lastCat ? ' selected' : ''}>${c}</option>`).join('');
    $('#q-cat').onchange = e => { S.lastCat = e.target.value; LS.set('todo.lastCat', S.lastCat); };
    $('#quick').onsubmit = e => onQuickSubmit(e, false);
    $('#q-title').addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); onQuickSubmit(null, true); }
    });

    $('#btn-report').onclick = openReport;
    $('#btn-bulk').onclick = openBulk;
    $('#btn-backup').onclick = backup;
    $('#btn-help').onclick = openHelp;
    $('#btn-logout').onclick = async () => { flushDeletes(); await sb.auth.signOut(); location.reload(); };

    $('#quickdate').addEventListener('change', onQuickDateChange);

    document.addEventListener('keydown', e => {
      if (e.isComposing) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
      if (e.key === 'Escape' && $('#dim')) { closeModal(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
      if (e.altKey && e.code === 'KeyR') { e.preventDefault(); openReport(); return; }
      if (e.altKey && e.code === 'KeyB') { e.preventDefault(); openBulk(); return; }
      if (typing || $('#dim')) return;
      if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
      else if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') { e.preventDefault(); if (S.tab !== 'todo') { S.tab = 'todo'; render(); } $('#q-title').focus(); }
      else if (e.key === '?') openHelp();
    });

    // 다른 기기에서 수정한 내용 반영: 창으로 돌아올 때 30초 이상 지났으면 새로고침
    window.addEventListener('focus', () => {
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
      if (!typing && !$('#dim') && Date.now() - S.loadedAt > 30000) loadAll();
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushDeletes(); });
    window.addEventListener('pagehide', flushDeletes);
    // 자정이 지나면 D-day·지연 표시 갱신
    let lastDay = today();
    setInterval(() => { if (today() !== lastDay) { lastDay = today(); render(); idleTalk(); } }, 60000);
  }

  /* =================== 로그인 / 시작 =================== */
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#login-email').focus(); }
  async function showApp() { $('#login').hidden = true; $('#app').hidden = false; await loadAll(); }

  async function boot() {
    bind();
    $('#login-form').onsubmit = async e => {
      e.preventDefault();
      $('#login-err').textContent = '';
      const { error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-pw').value });
      if (error) { $('#login-err').textContent = '로그인 실패: 이메일/비밀번호를 확인해 주세요'; return; }
      showApp();
    };
    const { data } = await sb.auth.getSession();
    if (data.session) showApp(); else showLogin();
    sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') showLogin(); });
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
