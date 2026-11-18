/* =====================================================================
 *  core.js — 화면·DB와 무관한 순수 로직 (날짜, 주차, 번호, 업무보고, 파서)
 * ===================================================================*/
(function (root) {
  'use strict';

  const CATS = ['상시', '제안/협의', '운영/관리', '기타'];
  const WEEKDAYS = '일월화수목금토';

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
  const startOfWeek = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
  const tsYmd = ts => (ts ? ymd(new Date(ts)) : null);
  const todayYmd = (now = new Date()) => ymd(now);

  /* 주차: 월요일 시작, "그 주의 목요일이 속한 달" 기준 */
  function weekInfo(d) {
    const mon = startOfWeek(d), thu = addDays(mon, 3), sun = addDays(mon, 6);
    return {
      mon, sun, monYmd: ymd(mon), sunYmd: ymd(sun),
      year: thu.getFullYear(), month: thu.getMonth() + 1, week: Math.ceil(thu.getDate() / 7),
    };
  }
  const weekLabel = d => { const w = weekInfo(d); return `${w.month}월 ${w.week}주차`; };

  const mmdd = s => { const d = parseYmd(s); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
  const sameMonth = (a, b) => a.slice(0, 7) === b.slice(0, 7);

  /* 업무보고용 기간 표기: (11/09-12), (11/30-12/02). 기간이 아니면 '' */
  function rangeText(start, due) {
    if (!start || !due || start === due) return '';
    return sameMonth(start, due) ? `(${mmdd(start)}-${due.slice(8)})` : `(${mmdd(start)}-${mmdd(due)})`;
  }

  /* 표 안의 날짜 셀 표기 */
  function dateCellText(start, due) {
    if (!start && !due) return '';
    if (start && due && start !== due) return sameMonth(start, due) ? `${mmdd(start)}-${due.slice(8)}` : `${mmdd(start)}-${mmdd(due)}`;
    const s = due || start;
    return `${mmdd(s)} (${WEEKDAYS[parseYmd(s).getDay()]})`;
  }

  const dday = (due, today) => (due ? Math.round((parseYmd(due) - parseYmd(today)) / 86400000) : null);
  const ddayLabel = n => (n === null ? '' : n === 0 ? 'D-day' : n > 0 ? `D-${n}` : `D+${-n}`);
  const isOverdue = (it, today) => !it.done && !!it.due_date && it.due_date < today;

  const ROMAN = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  function roman(n) { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; }

  /* 업무구분 정규화: "운" → 운영/관리 등 */
  function normCat(v) {
    v = (v || '').trim();
    if (!v) return null;
    if (CATS.includes(v)) return v;
    const c = v[0];
    if (c === '상') return '상시';
    if (c === '제' || c === '협') return '제안/협의';
    if (c === '운' || c === '관') return '운영/관리';
    if (c === '기') return '기타';
    return null;
  }

  const bySort = (a, b) => a.sort_order - b.sort_order;
  const isAlways = t => t.category === '상시';
  function orderTasks(tasks) {
    return tasks.filter(t => !isAlways(t)).sort(bySort).concat(tasks.filter(isAlways).sort(bySort));
  }
  /* 번호: 미완료 + 상시 아닌 작업만 1..n (상시는 '-') */
  function computeNumbers(tasks) {
    const m = {}; let n = 0;
    for (const t of tasks.filter(t => !t.done && !isAlways(t)).sort(bySort)) m[t.id] = ++n;
    return m;
  }

  /* 보고서 한 줄 이름: 프로젝트 + 작업 (작업이 프로젝트명으로 시작하면 중복 생략) */
  function taskName(t) {
    const p = (t.project || '').trim(), ti = (t.title || '').trim();
    if (!p) return ti;
    if (!ti) return p;
    return ti.startsWith(p) ? ti : `${p} ${ti}`;
  }
  const sectionOf = cat => (cat === '제안/협의' ? 0 : cat === '운영/관리' ? 1 : 2);

  /* =====================  주간 업무보고  =====================
   * 금주: 메인을 이번 주에 완료 OR 하위작업 중 이번 주 완료가 있는 작업
   *       (하위작업은 이번 주 완료분만 표기)
   * 차주: 미완료 메인 중 마감 ≤ 다음 주 일요일(지연·이번 주 미완료 포함)
   *       OR 미완료 하위작업 중 마감 ≤ 다음 주 일요일이 있는 작업
   *       (하위작업은 해당 조건 충족분만 표기)
   *       + 마감일 없는 미완료 작업(includeUndated, 상시 업무 등)
   * report_include=false(루틴) 는 제외 */
  function buildReport(tasks, subs, now = new Date(), opts = {}) {
    const includeUndated = opts.includeUndated !== false;
    const w = weekInfo(now);
    const nextSun = ymd(addDays(w.sun, 7));
    const byTask = {};
    for (const s of subs) (byTask[s.task_id] = byTask[s.task_id] || []).push(s);
    Object.values(byTask).forEach(a => a.sort(bySort));

    const doneThisWeek = it => { if (!it.done || !it.completed_at) return false; const d = tsYmd(it.completed_at); return d >= w.monYmd && d <= w.sunYmd; };
    const dueByNext = d => !!d && d <= nextSun;
    const fmt = (t, ss) => [`- ${taskName(t)}${rangeText(t.start_date, t.due_date)}`]
      .concat(ss.map((s, i) => `   ${roman(i + 1)}. ${(s.title || '').trim()}${rangeText(s.start_date, s.due_date)}`));

    const cur = [[], [], []], nxt = [[], [], []];
    for (const t of orderTasks(tasks.filter(t => t.report_include !== false))) {
      const ss = byTask[t.id] || [];
      const sec = sectionOf(t.category);
      const sd = ss.filter(doneThisWeek);
      if (doneThisWeek(t) || sd.length) cur[sec].push(fmt(t, sd));
      if (!t.done) {
        const sn = ss.filter(s => !s.done && dueByNext(s.due_date));
        if (dueByNext(t.due_date) || (!t.due_date && includeUndated) || sn.length) nxt[sec].push(fmt(t, sn));
      }
    }
    const H = ['1. 교육 제안/협의', '2. 교육 운영/관리', '3. 기타'];
    const block = arr => H.map((h, i) => [h].concat(arr[i].length ? arr[i].flat() : ['- ']).join('\n')).join('\n');
    return `${weekLabel(now)} 업무보고\n\n[금주 업무 진행사항]\n${block(cur)}\n[차주 업무 계획]\n${block(nxt)}`;
  }

  /* =====================  게이미피케이션  ===================== */
  function weekStats(tasks, subs, now = new Date()) {
    const w = weekInfo(now);
    const inW = it => { if (!it.done || !it.completed_at) return false; const d = tsYmd(it.completed_at); return d >= w.monYmd && d <= w.sunYmd; };
    const m = tasks.filter(inW).length, s = subs.filter(inW).length;
    return { main: m, sub: s, xp: m * 10 + s * 3 };
  }
  /* 연속 완료일(평일 기준, 주말은 건너뜀, 오늘 아직 없으면 어제부터) */
  function streak(tasks, subs, now = new Date()) {
    const set = new Set(tasks.concat(subs).filter(x => x.done && x.completed_at).map(x => tsYmd(x.completed_at)));
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()), n = 0, first = true;
    for (let i = 0; i < 500; i++) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        if (set.has(ymd(d))) n++;
        else if (!first) break;
        first = false;
      }
      d = addDays(d, -1);
    }
    return n;
  }

  /* =====================  입력 파서  ===================== */
  function mdToYmd(m, d, today) {
    const t = parseYmd(today); let y = t.getFullYear();
    const diff = (new Date(y, m - 1, d) - t) / 86400000;
    if (diff < -180) y++; else if (diff > 180) y--;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  const DAYWORD = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 0 };
  /* "11/20", "11/9-12", "11/30-12/2", "오늘", "내일", "금"/"금요일"(이번 주, 지났으면 다음 주) */
  function parseDateToken(tok, today) {
    if (tok === '오늘') return { start: null, due: today };
    if (tok === '내일') return { start: null, due: ymd(addDays(parseYmd(today), 1)) };
    const dw = tok.replace(/요일$/, '');
    if (dw.length === 1 && dw in DAYWORD) {
      const t = parseYmd(today); let diff = (DAYWORD[dw] - t.getDay() + 7) % 7;
      return { start: null, due: ymd(addDays(t, diff)) };
    }
    const m = tok.match(/^(\d{1,2})[/.](\d{1,2})(?:-(?:(\d{1,2})[/.])?(\d{1,2}))?$/);
    if (!m) return null;
    const s = mdToYmd(+m[1], +m[2], today);
    if (!m[4]) return { start: null, due: s };
    let e = mdToYmd(m[3] ? +m[3] : +m[1], +m[4], today);
    if (e < s) e = `${+e.slice(0, 4) + 1}${e.slice(4)}`;
    return { start: s, due: e };
  }
  /* 빠른입력 토큰: @날짜  !업무구분  #프로젝트(밑줄=공백)  끝의 (11/09-12) */
  function parseQuick(text, today) {
    const out = {};
    let rest = ` ${text} `;
    rest = rest.replace(/\s@(\S+)/g, (all, tok) => { const r = parseDateToken(tok, today); if (r) { out.start_date = r.start; out.due_date = r.due; return ' '; } return all; });
    rest = rest.replace(/\s!(\S+)/g, (all, tok) => { const c = normCat(tok); if (c) { out.category = c; return ' '; } return all; });
    rest = rest.replace(/\s#(\S+)/g, (all, tok) => { out.project = tok.replace(/_/g, ' '); return ' '; });
    rest = rest.replace(/\(([\d/.\-]+)\)\s*$/, (all, tok) => {
      const r = parseDateToken(tok, today);
      if (r && !out.due_date) { out.start_date = r.start; out.due_date = r.due; return ' '; }
      return all;
    });
    out.title = rest.replace(/\s+/g, ' ').trim();
    return out;
  }
  /* 일괄 붙여넣기: 들여쓰기·i./ii.·• 줄 = 하위작업, 그 외 = 메인 */
  function parseBulk(text, today) {
    const items = []; let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line = raw.trim();
      if (/^\[.*\]$/.test(line)) continue;                       // [금주 업무 진행사항] 같은 머리글
      const indented = /^[\t ]+/.test(raw);
      const romanLead = /^[ivxl]+[.)]\s/i.test(line);
      const dotLead = /^[·•∙◦▪]/.test(line);
      const clean = line.replace(/^(?:[-*•·∙◦▪]|\d+[.)]|[ivxl]+[.)]|\[[ xX]?\])\s*/i, '').trim();
      if (!clean) continue;
      const q = parseQuick(clean, today);
      if (!q.title) continue;
      if (cur && (indented || romanLead || dotLead)) cur.subs.push({ title: q.title, start_date: q.start_date || null, due_date: q.due_date || null });
      else { cur = Object.assign({ subs: [] }, q); items.push(cur); }
    }
    return items;
  }

  root.TodoCore = {
    CATS, pad, ymd, parseYmd, addDays, startOfWeek, tsYmd, todayYmd, weekInfo, weekLabel, mmdd,
    rangeText, dateCellText, dday, ddayLabel, isOverdue, roman, normCat, bySort, orderTasks,
    computeNumbers, taskName, buildReport, weekStats, streak, parseDateToken, parseQuick, parseBulk,
  };
})(typeof window !== 'undefined' ? window : globalThis);
