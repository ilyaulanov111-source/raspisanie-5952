'use strict';

const DATA_CACHE_KEY = 'tt_data_v1';
const HW_MIRROR_KEY = 'tt_homework_v1';
const HW_PREFIX = 'hw_';
const SHARED_DONE_KEY = 'tt_shared_done_v1';
const SHARED_DONE_PREFIX = 'hwd_';
const HW_MAX_TEXT = 3000;
const STALE_MINUTES = 180;
const WIDE_GAP_MINUTES = 40;
const SWIPE_DISTANCE = 60;

const WEEK_NAMES = { upper: 'верхняя неделя', lower: 'нижняя неделя' };
const STATUS = {
  cancelled: { label: 'не будет', tone: 'danger' },
  remote: { label: 'дистанционно', tone: 'info' },
  replaced: { label: 'замена', tone: 'warn' },
  added: { label: 'новая пара', tone: 'warn' },
  room: { label: 'другая аудитория', tone: 'warn' },
};

// Подгруппа и ключ к личным оценкам приходят в адресе кнопок бота. У главного приложения из профиля
// бота адрес общий для всех, поэтому их запоминаем в CloudStorage: оно своё у каждого человека
const IDENTITY_KEY = 'identity';
const urlParams = new URLSearchParams(location.search);
const fromBot = urlParams.has('g');
const initTab = ['schedule', 'changes', 'homework', 'grades'].includes(urlParams.get('tab')) ? urlParams.get('tab') : null;
let initDay = /^\d{4}-\d{2}-\d{2}$/.test(urlParams.get('day') ?? '') ? urlParams.get('day') : '';
let initSubj = urlParams.get('subj') || '';
let subgroup = Number(urlParams.get('sg')) || null;
let gradesKey = (urlParams.get('g') ?? '').toLowerCase();
const GRADES_CACHE_KEY = 'tt_grades_v2';
const VISITS = {
  '+': { label: 'был', tone: 'safe' },
  '-': { label: 'пропуск', tone: 'danger' },
  'Б': { label: 'болел', tone: 'info' },
  'У': { label: 'уважительная', tone: 'info' },
};

const state = {
  data: null,
  tab: initTab ?? 'schedule',
  renderedTab: initTab ?? 'schedule',
  selected: null,
  viewSubgroup: undefined,
  homework: [],
  sharedDone: new Set(),
  hwFilter: 'all',
  doneOpen: false,
  draft: null,
  draftBaseline: '',
  loadFailed: false,
  grades: null,
  gradesFailed: false,
  gradesLoadedFor: '',
  gradeSubject: 0,
  gradeFilter: 'all',
};

function activeSubgroup() {
  return state.viewSubgroup === undefined ? subgroup : state.viewSubgroup;
}

function visible(day) {
  const sg = activeSubgroup();
  return day.entries.filter((entry) => !sg || !entry.subgroup || entry.subgroup === sg);
}

function attending(day) {
  return visible(day).filter((entry) => entry.status !== 'cancelled');
}

function findDay(iso) {
  return state.data.days.find((day) => day.date === iso) ?? null;
}

function nextStudyDay(afterIso) {
  return state.data.days.find((day) => day.date > afterIso && attending(day).length) ?? null;
}

function nextLessonDates(subject, afterIso, limit) {
  return state.data.days
    .filter((day) => day.date > afterIso && attending(day).some((entry) => entry.subject === subject))
    .slice(0, limit)
    .map((day) => day.date);
}

// Первая подходящая дата: сегодня, а если пары уже кончились, то следующий учебный день
function defaultDate() {
  const now = mskNow();
  const today = findDay(now.date);
  const entries = today ? attending(today) : [];
  const hasMore = entries.some((entry) => toMinutes(entry.end || entry.start) > now.minutes);
  if (hasMore) return now.date;
  return nextStudyDay(now.date)?.date ?? state.data.days[0]?.date ?? now.date;
}

function heroState() {
  const now = mskNow();
  const today = findDay(now.date);
  const entries = (today ? attending(today) : []).filter((entry) => entry.start);
  const remaining = entries.filter((entry) => toMinutes(entry.end || entry.start) > now.minutes);
  const lastEntry = remaining[remaining.length - 1];
  const dayEnd = remaining.length && lastEntry?.end
    ? `осталось ${remaining.length} ${plural(remaining.length, 'пара', 'пары', 'пар')} · до ${lastEntry.end}`
    : '';
  const place = (entry) => [roomLabel(entry.room), entry.teacher].filter(Boolean).join(' · ');
  const pairName = (entry) => (entry.pair ? `${entry.pair} пара` : 'Занятие');

  const current = entries.find((entry) => entry.end && toMinutes(entry.start) <= now.minutes && now.minutes < toMinutes(entry.end));
  if (current) {
    const start = toMinutes(current.start);
    const end = toMinutes(current.end);
    return {
      eyebrow: `Сейчас · ${pairName(current)}`,
      title: current.subject,
      meta: place(current),
      left: `До конца ${duration(end - now.minutes)}`,
      until: current.end,
      dayEnd,
      progress: Math.round(((now.minutes - start) / (end - start)) * 100),
      danger: current.danger,
    };
  }

  const upcoming = entries.find((entry) => toMinutes(entry.start) > now.minutes);
  if (upcoming) {
    const isFirst = upcoming === entries[0];
    return {
      eyebrow: isFirst ? `Сегодня к ${upcoming.pair ?? '?'} паре` : `Следующая · ${pairName(upcoming)}`,
      title: upcoming.subject,
      meta: place(upcoming),
      left: `Через ${duration(toMinutes(upcoming.start) - now.minutes)}`,
      until: upcoming.start,
      dayEnd,
      danger: upcoming.danger,
    };
  }

  const next = nextStudyDay(now.date);
  if (!next) return { eyebrow: 'Пар пока не видно', title: 'В расписании пусто', meta: '' };
  const first = attending(next)[0];
  const when = relativeDay(next.date) ?? shortDate(next.date);
  const arrive = first.pair ? `к ${first.pair} паре` : 'к началу';
  return {
    eyebrow: entries.length ? 'На сегодня всё' : 'Сегодня пар нет',
    title: `${when} ${arrive}, в ${first.start}`,
    meta: first.subject,
    danger: first.danger,
  };
}

function renderHero() {
  const hero = heroState();
  document.getElementById('hero')?.classList.toggle('is-danger', Boolean(hero.danger));
  const warning = hero.danger ? '<span class="hero-hazard">⚠ ОПАСНОСТЬ</span>' : '';
  const timing = hero.left
    ? `<div class="hero-left"><span>${esc(hero.left)}</span><span>${esc(hero.until)}</span></div>`
    : '';
  const summary = hero.dayEnd ? `<p class="hero-summary">${esc(hero.dayEnd)}</p>` : '';
  const bar = hero.progress === undefined ? '' : `<div class="hero-bar"><i style="width:${hero.progress}%"></i></div>`;
  return `
    <p class="hero-eyebrow">${esc(hero.eyebrow)}${warning}</p>
    <h2 class="hero-title">${esc(hero.title)}</h2>
    ${hero.meta ? `<p class="hero-meta">${esc(hero.meta)}</p>` : ''}
    ${summary}${timing}${bar}`;
}

function freshnessNote() {
  const checked = Date.parse(state.data.checked_at);
  const minutes = Math.max(0, Math.round((Date.now() - checked) / 60000));
  if (minutes < 2) return { text: 'проверено только что', stale: false };
  const age = minutes < 60 ? `${minutes} мин` : minutes < 1440 ? `${Math.round(minutes / 60)} ч` : `${Math.round(minutes / 1440)} дн`;
  const nextCheck = state.data.next_check ? Date.parse(state.data.next_check) : NaN;
  const stale = Number.isNaN(nextCheck)
    ? minutes > STALE_MINUTES
    : Date.now() > nextCheck + 45 * 60000 || minutes > 26 * 60;
  return { text: `проверено ${age} назад`, stale };
}

function sessionEventsFor(dateIso) {
  return (state.data?.session?.events ?? []).filter((item) => item.date === dateIso);
}

function sessionChipLabel() {
  const session = state.data?.session;
  if (!session) return '';
  const today = mskNow().date;
  const events = (session.events ?? []).filter((item) => item.date >= today);
  const start = session.start || events[0]?.date || '';
  if (!start) return '';
  if (start > today) {
    const a = Date.UTC(...start.split('-').map((n, i) => (i === 1 ? n - 1 : Number(n))));
    const b = Date.UTC(...today.split('-').map((n, i) => (i === 1 ? n - 1 : Number(n))));
    const days = Math.round((a - b) / 86400000);
    return `🎓 До сессии ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  if (start === today || events.some((item) => item.date === today)) return '🎓 Сессия сегодня';
  return events.length ? '🎓 Сессия' : '';
}

function renderHead() {
  const now = mskNow();
  const today = findDay(now.date);
  const note = freshnessNote();
  const viewSg = activeSubgroup();
  const isPreview = state.viewSubgroup !== undefined && viewSg !== subgroup;
  const sgLabel = viewSg ? `п/г ${viewSg}` : 'обе п/г';
  const showReturn = state.selected && state.selected !== defaultDate();
  const sessionLabel = sessionChipLabel();
  const chips = [
    today?.week ? `<span class="chip">${WEEK_NAMES[today.week]}</span>` : '',
    `<button class="chip chip-button ${isPreview ? 'chip-preview' : ''}" data-action="cycle-subgroup" title="Переключить показ подгруппы">${isPreview ? '👀 ' : ''}${sgLabel}</button>`,
    today?.short ? '<span class="chip chip-short">✂️ сокращённый день</span>' : '',
    sessionLabel ? `<button class="chip chip-button chip-session" data-action="session">${esc(sessionLabel)}</button>` : '',
    state.data?.pair_times ? '<button class="chip chip-button" data-action="bells">🕒 Звонки</button>' : '',
    showReturn ? '<button class="chip chip-button chip-return" data-action="go-today">↩ К сегодня</button>' : '',
    '<button class="chip chip-button" data-action="settings">⚙️ Настройки</button>',
  ].join('');
  const warning = note.stale || !state.data.portal_ok || state.loadFailed
    ? `<p class="banner">${state.loadFailed ? 'Нет связи, показываю сохранённые данные.' : 'Портал давно не отвечал, свежие замены могут не отображаться.'}</p>`
    : '';
  const previewNotice = isPreview
    ? `<p class="banner banner-info">Предпросмотр (${sgLabel}). Уведомления бота по-прежнему для ${subgroup ? `п/г ${subgroup}` : 'обеих подгрупп'} — сменить можно в ⚙️ Настройках.</p>`
    : '';
  return `
    <header class="head">
      <h1>${esc(fullDate(now.date))}</h1>
      <div class="head-meta">${chips}<span>${esc(note.text)}</span></div>
      ${warning}${previewNotice}
    </header>`;
}

function renderStrip() {
  const today = mskNow().date;
  const days = state.data.days.filter((day) => dateParts(day.date).weekday !== 0 || day.date === today);
  const parts = [];
  let prevMonth = null;
  days.forEach((day, index) => {
    const { day: number, month, weekday } = dateParts(day.date);
    if (index && prevMonth !== month) parts.push(`<span class="strip-month">${esc(MONTHS_SHORT[month])}</span>`);
    else if (index && weekday === 1) parts.push('<i class="strip-week"></i>');
    prevMonth = month;
    const classes = ['strip-day', day.date === state.selected ? 'is-active' : '', day.date === today ? 'is-today' : ''].join(' ');
    const changed = visible(day).some((entry) => entry.status !== 'normal');
    const hasSession = sessionEventsFor(day.date).length > 0;
    const hazard = attending(day).some((entry) => entry.danger) ? '<i class="hazard">!</i>' : '';
    parts.push(`
      <button class="${classes}" data-action="day" data-date="${day.date}" aria-pressed="${day.date === state.selected}">
        <small>${WEEKDAYS_SHORT[weekday]}</small><b>${number}</b>${hasSession ? '<i class="dot dot-session"></i>' : changed ? '<i class="dot"></i>' : ''}${hazard}
      </button>`);
  });
  return `<div class="strip" id="strip">${parts.join('')}</div>`;
}

function allHomework() {
  const sg = activeSubgroup();
  const shared = (state.data?.homework ?? [])
    .filter((item) => !sg || !item.subgroup || item.subgroup === sg)
    .map((item) => ({
    ...item,
    id: `s${item.id}`,
    shared: true,
    done: state.sharedDone.has(String(item.id)),
  }));
  return [...state.homework, ...shared];
}

function homeworkFor(date, subject) {
  return allHomework().filter((item) => item.due === date && item.subject === subject && !item.done);
}

// Темы из журналов преподавателей: тема этого дня или, для будущей пары, тема прошлой
function topicLine(day, entry) {
  const topics = (state.data.topics ?? []).filter((item) => item.teacher && entry.teacher.includes(item.teacher));
  if (!topics.length) return '';
  const same = topics.find((item) => item.date === day.date);
  if (same) return `<p class="topic">📖 ${esc(same.topic)}</p>`;
  const before = topics.filter((item) => item.date < day.date).pop();
  return before ? `<p class="topic">📖 Прошлое занятие: ${esc(before.topic)}</p>` : '';
}

function dangerTag(entry) {
  if (!entry.danger) return '';
  return entry.status === 'cancelled'
    ? '<span class="tag tag-safe">опасность миновала</span>'
    : '<span class="tag tag-hazard">⚠ опасность</span>';
}

function manualTag(entry) {
  return entry.manual ? '<span class="tag tag-info">от создателя</span>' : '';
}

function renderLesson(day, entry, isNow, isPast) {
  const status = STATUS[entry.status];
  const pairLabel = entry.pair ? `${entry.pair} пара` : 'Вне сетки';
  const sub = entry.subgroup && !activeSubgroup() ? ` · п/г ${entry.subgroup}` : '';
  const tag = status ? `<span class="tag tag-${status.tone}">${status.label}</span>` : '';
  const details = [entry.teacher, roomLabel(entry.room)].filter(Boolean).join(' · ');
  const note = entry.note ? `<p>${esc(entry.note)}</p>` : '';
  const was = entry.was ? `<p>Вместо: ${esc(entry.was)}</p>` : '';
  const tasks = homeworkFor(day.date, entry.subject)
    .map((item) => `<button class="hw-pill" data-action="view-hw" data-id="${esc(item.id)}">ДЗ: ${esc(item.text)}</button>`)
    .join('');
  const addButton = entry.status === 'cancelled'
    ? ''
    : `<button class="hw-add" data-action="add-hw" data-subject="${esc(entry.subject)}" data-after="${day.date}">+ ДЗ</button>`;
  const classes = [
    'lesson',
    entry.status === 'cancelled' ? 'is-cancelled' : '',
    isNow ? 'is-now' : '',
    isPast ? 'is-past' : '',
    entry.danger ? 'is-danger' : '',
  ].join(' ');
  return `
    <article class="${classes}">
      <div class="lesson-time"><b>${esc(entry.start)}</b><span>${esc(entry.end)}</span></div>
      <div class="lesson-body" style="--subject:${subjectColor(entry.subject)}">
        <div class="lesson-top"><span>${pairLabel}${sub}</span>${tag}${manualTag(entry)}${dangerTag(entry)}</div>
        <h3>${esc(entry.subject)}</h3>
        ${details ? `<p>${esc(details)}</p>` : ''}${note}${was}${topicLine(day, entry)}
        <div class="lesson-foot">${tasks}${addButton}</div>
      </div>
    </article>`;
}

function renderDayList() {
  const day = findDay(state.selected);
  if (!day) return '';
  const relative = relativeDay(day.date);
  const title = relative ?? `${WEEKDAYS[dateParts(day.date).weekday]}`;
  const { day: number, month } = dateParts(day.date);
  const small = `${number} ${MONTHS[month]}${day.week ? ` · ${WEEK_NAMES[day.week].split(' ')[0]}` : ''}${day.short ? ' · сокращённый' : ''}`;
  const heading = `<h2 class="section-title"><span>${esc(title)}</span><small>${esc(small)}</small></h2>`;

  const sessionCards = sessionEventsFor(day.date).map((item) => `
    <article class="lesson is-session">
      <div class="lesson-time"><b>${esc(item.time || '—')}</b><span>${esc(item.kind || 'Сессия')}</span></div>
      <div class="lesson-body" style="--subject:var(--accent)">
        <div class="lesson-top"><span class="tag tag-info">🎓 ${esc(item.kind || 'Сессия')}</span></div>
        <h3>${esc(item.subject)}</h3>
        ${item.room ? `<p>${esc(roomLabel(item.room))}</p>` : ''}
      </div>
    </article>`);

  const entries = visible(day);
  if (!entries.length && !sessionCards.length) {
    const reason = day.holiday ? `<strong>${esc(day.holiday)}</strong>Пар нет` : '<strong>Пар нет</strong>Можно выдохнуть';
    return `${heading}<div class="empty">${reason}</div>`;
  }
  const now = mskNow();
  const blocks = [...sessionCards];
  let previousEnd = null;
  for (const entry of entries) {
    const start = toMinutes(entry.start);
    if (previousEnd !== null && start - previousEnd >= WIDE_GAP_MINUTES) {
      blocks.push(`<div class="gap">перерыв ${esc(duration(start - previousEnd))}</div>`);
    }
    const endMinutes = entry.end ? toMinutes(entry.end) : start + 100;
    const isNow = day.date === now.date && entry.end && entry.status !== 'cancelled'
      && start <= now.minutes && now.minutes < endMinutes;
    const isPast = day.date === now.date && Boolean(entry.start) && !isNow && endMinutes <= now.minutes;
    blocks.push(renderLesson(day, entry, isNow, isPast));
    if (entry.status !== 'cancelled' && entry.end) previousEnd = toMinutes(entry.end);
  }
  return `${heading}<div class="lessons">${blocks.join('')}</div>`;
}

function renderSchedule() {
  const danger = heroState().danger ? ' is-danger' : '';
  return `${renderHead()}<section class="hero${danger}" id="hero">${renderHero()}</section>${renderStrip()}<div id="day-list">${renderDayList()}</div>`;
}

function upcomingChanges() {
  const today = mskNow().date;
  return state.data.days
    .filter((day) => day.date >= today)
    .map((day) => ({ day, entries: visible(day).filter((entry) => entry.status !== 'normal') }))
    .filter((item) => item.entries.length);
}

function renderChanges() {
  const items = upcomingChanges();
  const heading = '<h1 class="section-title" style="margin-top:2px;font-size:25px">Замены</h1>';
  if (!items.length) {
    return `${heading}<div class="empty"><strong>Замен нет</strong>Как только появятся, бот напишет в личные сообщения.<br>${esc(freshnessNote().text)}</div>`;
  }
  const cards = items.map(({ day, entries }) => {
    const rows = entries.map((entry) => {
      const status = STATUS[entry.status];
      const when = entry.pair ? `${entry.pair} пара, ${entry.start}` : `с ${entry.start}`;
      const details = [entry.teacher, roomLabel(entry.room)].filter(Boolean).join(' · ');
      return `
        <div class="change-row">
          <div class="lesson-top"><span>${esc(when)}</span><span class="tag tag-${status.tone}">${status.label}</span>${manualTag(entry)}</div>
          <strong>${esc(entry.subject)}</strong>
          ${details ? `<p>${esc(details)}</p>` : ''}
          ${entry.was ? `<p>Вместо: ${esc(entry.was)}</p>` : ''}
          ${entry.note ? `<p>${esc(entry.note)}</p>` : ''}
        </div>`;
    }).join('');
    const label = relativeDay(day.date) ? `${relativeDay(day.date)}, ${shortDate(day.date)}` : shortDate(day.date);
    return `<article class="change-day"><h3>${esc(label)}</h3>${rows}</article>`;
  }).join('');
  return heading + cards;
}

function renderSharedHomeworkItem(item) {
  return `
    <article class="hw-item is-shared ${item.done ? 'is-done' : ''}">
      <button class="hw-check" data-action="toggle-hw" data-id="${esc(item.id)}" aria-pressed="${item.done}" aria-label="Отметить выполненным">
        <svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7.5"/></svg>
      </button>
      <div class="hw-main" role="button" tabindex="0" data-action="view-hw" data-id="${esc(item.id)}">
        <strong>${esc(item.subject)} · ${esc(relativeDay(item.due) ?? shortDate(item.due))}</strong>
        <span>${linkify(item.text)}</span>
      </div>
      <i class="hw-shared-mark">${item.subgroup ? `п/г ${item.subgroup}` : 'общее'}</i>
    </article>`;
}

function renderHomeworkItem(item) {
  if (item.shared) return renderSharedHomeworkItem(item);
  return `
    <article class="hw-item ${item.done ? 'is-done' : ''}">
      <button class="hw-check" data-action="toggle-hw" data-id="${esc(item.id)}" aria-pressed="${item.done}" aria-label="Отметить выполненным">
        <svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7.5"/></svg>
      </button>
      <div class="hw-main" role="button" tabindex="0" data-action="edit-hw" data-id="${esc(item.id)}">
        <strong>${esc(item.subject)} · ${esc(relativeDay(item.due) ?? shortDate(item.due))}</strong>
        <span>${linkify(item.text)}</span>
      </div>
    </article>`;
}

function renderHomework() {
  const today = mskNow().date;
  const tomorrow = addDays(today, 1);
  const byDue = (a, b) => a.due.localeCompare(b.due);
  const homework = allHomework();
  const allOpen = homework.filter((item) => !item.done).sort(byDue);
  const filter = allOpen.length >= 4 ? state.hwFilter : 'all';
  const open = allOpen.filter((item) => {
    if (filter === 'tomorrow') return item.due <= tomorrow;
    if (filter === 'shared') return Boolean(item.shared);
    return true;
  });
  const late = open.filter((item) => item.due < today);
  const coming = open.filter((item) => item.due >= today);
  const done = homework.filter((item) => item.done).sort(byDue).reverse();
  const hasPersonalDone = done.some((item) => !item.shared);

  const filterChip = (key, label) => `<button class="chip chip-button ${filter === key ? 'chip-return' : ''}" data-action="hw-filter" data-filter="${key}">${label}</button>`;
  const filters = allOpen.length >= 4
    ? `<div class="hw-filters">${filterChip('all', `Все (${allOpen.length})`)}${filterChip('tomorrow', 'Срочные')}${filterChip('shared', 'Общие')}</div>`
    : '';

  const group = (title, items, extra = '') => items.length
    ? `<h2 class="hw-group ${extra}">${title}</h2>${items.map(renderHomeworkItem).join('')}`
    : '';
  const doneBlock = done.length
    ? `
      <h2 class="hw-group">
        <button class="hw-spoiler" data-action="toggle-done" aria-expanded="${state.doneOpen}">
          <span>Сделано (${done.length})</span>
          <span>${state.doneOpen ? '▴' : '▾'}</span>
        </button>
      </h2>
      ${state.doneOpen ? `
        ${hasPersonalDone ? '<div class="hw-done-bar"><button class="chip chip-button" data-action="clear-done">Очистить личные</button></div>' : ''}
        ${done.map(renderHomeworkItem).join('')}
      ` : ''}`
    : '';
  const heading = '<h1 class="section-title" style="margin-top:2px;font-size:25px">Домашка</h1>';
  const empty = homework.length ? '' : '<div class="empty"><strong>Пока пусто</strong>Нажми плюс или «+ ДЗ» у пары: срок подставится сам, по следующей паре предмета.</div>';
  const filteredEmpty = homework.length && !open.length && filter !== 'all'
    ? '<div class="empty"><strong>По этому фильтру пусто</strong></div>'
    : '';
  return `${heading}${filters}${empty}${filteredEmpty}${group('Просрочено', late, 'is-late')}${group('Предстоит', coming)}${doneBlock}
    <button class="fab" data-action="add-hw" aria-label="Добавить задание">+</button>`;
}

function gradeTone(value) {
  if (/^н(?:\/|$)/i.test(String(value).trim())) return 'low';
  const number = parseFloat(String(value).replace(',', '.'));
  if (Number.isNaN(number)) return 'none';
  if (number >= 4.5) return 'top';
  if (number >= 3.5) return 'good';
  if (number >= 2.5) return 'mid';
  return 'low';
}

function renderGrades() {
  const heading = '<h1 class="section-title page-title">Оценки</h1>';
  if (!gradesKey) {
    return `${heading}<div class="empty"><strong>Оценки по предметам</strong>Появятся здесь, когда создатель свяжет тебя со строкой в таблицах преподавателей. Напиши ему, это минута.</div>`;
  }
  if (!state.grades) {
    return state.gradesFailed
      ? `${heading}<div class="empty"><strong>Не удалось загрузить оценки</strong>Проверь интернет и открой приложение ещё раз.</div>`
      : `${heading}<div class="skeleton"></div><div class="skeleton"></div>`;
  }
  // Раньше в файле был один предмет без списка
  const subjects = state.grades.subjects ?? [state.grades];
  const index = Math.min(state.gradeSubject, subjects.length - 1);
  const switcher = subjects.length > 1
    ? `<div class="grade-tiles">${subjects.map((subject, i) => {
        const debts = (subject.missing_works ?? []).length;
        const badge = debts ? `<span class="grade-tile-debt">−${debts}</span>` : '';
        const score = subject.final || subject.average || '—';
        return `
          <button class="grade-tile ${i === index ? 'is-active' : ''}" data-action="grade-subject" data-index="${i}" aria-pressed="${i === index}">
            <div class="grade-tile-top"><strong>${esc(subject.short ?? subject.title)}</strong>${badge}</div>
            <span>${subject.final ? 'итог ' : 'ср. '}${esc(score)}</span>
          </button>`;
      }).join('')}
      </div>`
    : '';
  return heading + switcher + renderSubjectGrades(subjects[index]);
}

function isMissedMark(mark) {
  return /^(?:-|н(?:\/.*)?)$/i.test(String(mark || '').trim());
}

function isAbsenceOrExcuse(mark) {
  return /^(?:-|н(?:\/.*)?|б|у)$/i.test(String(mark || '').trim());
}

function lessonMark(grades, lesson) {
  const mark = String(lesson.mark || '').trim();
  const lower = mark.toLowerCase();
  if (lower === 'н') return '<span class="tag tag-danger">не был</span>';
  if (lower === 'б') return '<span class="tag tag-info">болел</span>';
  if (lower === 'у') return '<span class="tag tag-info">уважительная</span>';
  if (grades.graded) {
    if (!mark) return '<span class="tag tag-muted">нет оценки</span>';
    return `<b class="grade-chip tone-${gradeTone(mark)}">${esc(mark)}</b>`;
  }
  const visit = VISITS[lesson.mark];
  return visit ? `<span class="tag tag-${visit.tone}">${visit.label}</span>` : '<span class="tag tag-muted">нет отметки</span>';
}

function renderSubjectGrades(grades) {
  const attendance = parseFloat(String(grades.attendance).replace(',', '.'));
  const works = grades.works.map((work) => `
    <div class="grade-row">
      <span>${esc(work.title)}</span>
      <b class="grade-chip tone-${gradeTone(work.mark)}">${esc(work.mark)}</b>
    </div>`).join('');
  const missing = (grades.missing_works ?? []).map((title) => `
    <div class="grade-row">
      <span>${esc(title)}</span>
      <span class="tag tag-danger">не сдано</span>
    </div>`).join('');
  const missedCount = grades.lessons.filter((lesson) => isMissedMark(lesson.mark)).length;
  const absenceCount = grades.lessons.filter((lesson) => isAbsenceOrExcuse(lesson.mark)).length;
  const markedCount = grades.lessons.filter((lesson) => lesson.mark && !isAbsenceOrExcuse(lesson.mark)).length;
  const filteredLessons = grades.lessons.filter((lesson) => {
    if (state.gradeFilter === 'absent') return isAbsenceOrExcuse(lesson.mark);
    if (state.gradeFilter === 'marked') return Boolean(lesson.mark) && !isAbsenceOrExcuse(lesson.mark);
    return true;
  });
  const lessons = filteredLessons.map((lesson) => {
    const when = lesson.date ? shortDate(lesson.date) : lesson.label;
    return `
      <div class="grade-lesson">
        <div><strong>${esc(when)}</strong><span>${esc(lesson.topic || 'Без темы')}</span></div>
        ${lessonMark(grades, lesson)}
      </div>`;
  }).join('');
  const gradeFilterChip = (key, label) => `<button class="chip chip-button ${state.gradeFilter === key ? 'chip-return' : ''}" data-action="grade-filter" data-filter="${key}">${label}</button>`;
  const journalFilters = grades.lessons.length
    ? `<div class="hw-filters">${gradeFilterChip('all', `Все (${grades.lessons.length})`)}${absenceCount ? gradeFilterChip('absent', `Пропуски (${absenceCount})`) : ''}${markedCount ? gradeFilterChip('marked', grades.graded ? `С оценкой (${markedCount})` : `Был (${markedCount})`) : ''}</div>`
    : '';
  let second;
  if (grades.graded) {
    const marked = grades.lessons.filter((lesson) => lesson.mark && !/^[нбу]$/i.test(String(lesson.mark).trim())).length;
    second = `<p><b>${marked}</b> ${plural(marked, 'оценка', 'оценки', 'оценок')}${missedCount ? ` · <span class="grade-missed">${missedCount} ${plural(missedCount, 'пропуск', 'пропуска', 'пропусков')}</span>` : ''}</p>`;
  } else {
    second = `
      <p><b>${esc(grades.attendance || '—')}%</b> посещаемость${missedCount ? ` · ${missedCount} ${plural(missedCount, 'пропуск', 'пропуска', 'пропусков')}` : ''}</p>
      <div class="grade-bar"><i style="width:${Number.isNaN(attendance) ? 0 : Math.min(100, attendance)}%"></i></div>`;
  }
  const updated = grades.checked_at ? `обновлено ${esc(dateLabelShort(grades.checked_at))}` : '';
  return `
    <p class="grade-subtitle">${esc(grades.title)}${updated ? ` · ${updated}` : ''}</p>
    <section class="grade-hero tone-${gradeTone(grades.final)}">
      <div class="grade-final"><b>${esc(grades.final || '—')}</b><span>итог</span></div>
      <div class="grade-stats">
        <p><b>${esc(grades.average || '—')}</b> средний балл</p>
        ${second}
      </div>
    </section>
    ${missing ? `<h2 class="hw-group is-late">Не сдано в группе (${grades.missing_works.length})</h2><section class="grade-card">${missing}</section>` : ''}
    ${works ? `<h2 class="hw-group">${esc(grades.works_title ?? 'Практические работы')}</h2><section class="grade-card">${works}</section>` : ''}
    ${grades.lessons.length ? `<h2 class="hw-group">Журнал занятий</h2>${journalFilters}<section class="grade-card">${lessons || '<p class="grade-empty-note">По этому фильтру записей нет</p>'}</section>` : ''}`;
}

function dateLabelShort(iso) {
  const day = iso.slice(0, 10);
  const relative = relativeDay(day);
  return relative ? `${relative.toLowerCase()} в ${iso.slice(11, 16)}` : shortDate(day);
}

function applyInitialSubject() {
  if (!initSubj || !state.grades) return;
  const subjects = state.grades.subjects ?? [state.grades];
  const target = initSubj.toLowerCase();
  const idx = subjects.findIndex((s) => (s.short ?? '').toLowerCase() === target || (s.title ?? '').toLowerCase().includes(target));
  if (idx >= 0) state.gradeSubject = idx;
  initSubj = '';
}

async function loadGrades() {
  if (!/^[0-9a-f]{64}$/.test(gradesKey) || state.gradesLoadedFor === gradesKey) return;
  state.gradesLoadedFor = gradesKey;
  state.grades = readStorage(GRADES_CACHE_KEY);
  applyInitialSubject();
  try {
    const name = (await sha256Hex(gradesKey)).slice(0, 24);
    const response = await fetchFresh(`g/${name}.bin`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.grades = await decrypt(await response.arrayBuffer(), gradesKey);
    writeStorage(GRADES_CACHE_KEY, state.grades);
    applyInitialSubject();
  } catch {
    state.gradesFailed = !state.grades;
    if (!state.grades) state.gradesLoadedFor = '';
  }
  if (state.tab === 'grades') render();
}

function renderBadges() {
  const today = mskNow().date;
  const counters = {
    'badge-changes': upcomingChanges().reduce((sum, item) => sum + item.entries.length, 0),
    'badge-homework': allHomework().filter((item) => !item.done && item.due <= addDays(today, 1)).length,
  };
  for (const [id, count] of Object.entries(counters)) {
    const badge = document.getElementById(id);
    badge.hidden = !count;
    badge.textContent = count;
  }
}

function render() {
  const view = document.getElementById('view');
  const keepScroll = state.renderedTab === state.tab;
  const prevScroll = keepScroll ? window.scrollY : 0;
  state.renderedTab = state.tab;
  view.classList.toggle('has-fab', state.tab === 'homework' && Boolean(state.data));
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
  });
  if (!state.data) {
    view.innerHTML = state.loadFailed
      ? '<div class="empty"><strong>Не удалось загрузить расписание</strong>Проверь интернет и открой приложение ещё раз.</div>'
      : '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    return;
  }
  if (state.tab === 'schedule') view.innerHTML = renderSchedule();
  if (state.tab === 'changes') view.innerHTML = renderChanges();
  if (state.tab === 'homework') view.innerHTML = renderHomework();
  if (state.tab === 'grades') view.innerHTML = renderGrades();
  renderBadges();
  if (keepScroll) window.scrollTo(0, prevScroll);
}

function revealSelectedDay(behavior = 'auto') {
  document.querySelector('.strip-day.is-active')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
}

// ДЗ хранится в Telegram CloudStorage, а копия в браузере нужна на случай работы без Telegram
function cloud() {
  return tg?.CloudStorage && tg.isVersionAtLeast?.('6.9') ? tg.CloudStorage : null;
}

function cloudCall(method, ...args) {
  return new Promise((resolve, reject) => {
    cloud()[method](...args, (error, result) => (error ? reject(new Error(error)) : resolve(result)));
  });
}

async function loadIdentity() {
  const current = JSON.stringify({ sg: subgroup, g: gradesKey });
  if (fromBot) {
    writeStorage(IDENTITY_KEY, current);
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.hash);
    if (cloud()) await cloudCall('setItem', IDENTITY_KEY, current).catch(() => {});
    return;
  }
  let saved = readStorage(IDENTITY_KEY);
  if (cloud()) saved = (await cloudCall('getItem', IDENTITY_KEY).catch(() => '')) || saved;
  if (!saved) return;
  const identity = JSON.parse(saved);
  subgroup = Number(identity.sg) || null;
  gradesKey = String(identity.g ?? '').toLowerCase();
  render();
}

function loadLocalHomework() {
  state.homework = readStorage(HW_MIRROR_KEY) ?? [];
  state.sharedDone = new Set(readStorage(SHARED_DONE_KEY) ?? []);
}

async function loadHomework() {
  loadLocalHomework();
  if (!cloud()) return;
  try {
    const allKeys = await cloudCall('getKeys');
    const keys = allKeys.filter((key) => key.startsWith(HW_PREFIX));
    const values = keys.length ? await cloudCall('getItems', keys) : {};
    state.homework = Object.values(values).filter(Boolean).map((value) => JSON.parse(value));
    writeStorage(HW_MIRROR_KEY, state.homework);
    const doneKeys = allKeys.filter((key) => key.startsWith(SHARED_DONE_PREFIX));
    state.sharedDone = new Set(doneKeys.map((key) => key.slice(SHARED_DONE_PREFIX.length)));
    writeStorage(SHARED_DONE_KEY, [...state.sharedDone]);
  } catch {
    toast('Не удалось загрузить ДЗ из Telegram');
  }
}

async function saveHomework(item) {
  const index = state.homework.findIndex((other) => other.id === item.id);
  if (index >= 0) state.homework[index] = item;
  else state.homework.push(item);
  writeStorage(HW_MIRROR_KEY, state.homework);
  if (!cloud()) return;
  try {
    await cloudCall('setItem', HW_PREFIX + item.id, JSON.stringify(item));
  } catch {
    toast('ДЗ сохранено только на этом устройстве');
  }
}

async function removeHomework(id) {
  state.homework = state.homework.filter((item) => item.id !== id);
  writeStorage(HW_MIRROR_KEY, state.homework);
  if (!cloud()) return;
  try {
    await cloudCall('removeItem', HW_PREFIX + id);
  } catch {
    toast('Не удалось удалить ДЗ в Telegram');
  }
}

async function toggleSharedHomework(id) {
  const key = id.slice(1);
  const done = !state.sharedDone.has(key);
  if (done) state.sharedDone.add(key);
  else state.sharedDone.delete(key);
  writeStorage(SHARED_DONE_KEY, [...state.sharedDone]);
  if (!cloud()) return;
  try {
    await (done ? cloudCall('setItem', SHARED_DONE_PREFIX + key, '1') : cloudCall('removeItem', SHARED_DONE_PREFIX + key));
  } catch {
    toast('Отметка сохранена только на этом устройстве');
  }
}

function openSheet(draft) {
  state.draft = draft;
  state.draftBaseline = draft.type ? '' : JSON.stringify({ subject: draft.subject, text: draft.text, due: draft.due });
  renderSheet();
  tg?.BackButton?.show();
}

function closeSheet() {
  state.draft = null;
  state.draftBaseline = '';
  document.getElementById('sheet-root').innerHTML = '';
  tg?.BackButton?.hide();
}

function closeSheetSafely() {
  if (!state.draft || state.draft.type) {
    closeSheet();
    return;
  }
  keepDraftText();
  const current = JSON.stringify({ subject: state.draft.subject, text: state.draft.text, due: state.draft.due });
  if (state.draft.text.trim() && current !== state.draftBaseline) {
    confirmThen('Закрыть без сохранения изменений?', closeSheet);
    return;
  }
  closeSheet();
}

function renderBellsSheet() {
  const times = state.data?.pair_times;
  if (!times) return '';
  const today = findDay(mskNow().date);
  const weekday = dateParts(mskNow().date).weekday;
  const activeMode = today?.short ? 'short' : weekday === 6 ? 'saturday' : 'regular';
  const block = (key, title) => {
    const rows = (times[key] ?? [])
      .map((row) => `<div class="bell-row"><span>${row.pair} пара</span><b>${esc(row.start)}–${esc(row.end)}</b></div>`)
      .join('');
    return `
      <span class="field-label">${esc(title)}${activeMode === key ? ' · сегодня' : ''}</span>
      <section class="grade-card">${rows}</section>`;
  };
  return `
    <div class="sheet-back" data-action="close-sheet"></div>
    <section class="sheet" role="dialog" aria-label="Расписание звонков">
      <div class="sheet-grip"></div>
      <h2>Расписание звонков</h2>
      ${block('regular', 'Будни')}
      ${block('saturday', 'Суббота (по 1 часу)')}
      ${block('short', 'Сокращённый день (по 45 минут)')}
    </section>`;
}

function renderViewHomeworkSheet(item) {
  if (!item) return '';
  const meta = `${relativeDay(item.due) ?? shortDate(item.due)} · ${item.shared ? (item.subgroup ? `общее · п/г ${item.subgroup}` : 'общее') : 'личное'}`;
  return `
    <div class="sheet-back" data-action="close-sheet"></div>
    <section class="sheet" role="dialog" aria-label="Домашнее задание">
      <div class="sheet-grip"></div>
      <h2>${esc(item.subject)}</h2>
      <span class="field-label">${esc(meta)}</span>
      <div class="hw-view-text">${linkify(item.text)}</div>
      <div class="sheet-actions">
        <button class="primary" data-action="toggle-hw-sheet" data-id="${esc(item.id)}">${item.done ? '↩ Вернуть в работу' : '✓ Сделано'}</button>
        ${item.shared ? '' : `<button class="secondary-btn" data-action="edit-hw" data-id="${esc(item.id)}">✏️ Редактировать</button>`}
        <button class="secondary-btn" data-action="goto-homework">Все задания →</button>
      </div>
    </section>`;
}

function renderSessionSheet() {
  const session = state.data?.session;
  if (!session) return '';
  const today = mskNow().date;
  const events = (session.events ?? []).filter((item) => item.date >= today);
  const rows = events.map((item) => `
    <div class="grade-lesson">
      <div><strong>${esc(shortDate(item.date))}${item.time ? ` · ${esc(item.time)}` : ''} · ${esc(item.kind || 'Сессия')}</strong><span>${esc(item.subject)}${item.room ? ` · ${esc(roomLabel(item.room))}` : ''}</span></div>
    </div>`).join('');
  return `
    <div class="sheet-back" data-action="close-sheet"></div>
    <section class="sheet" role="dialog" aria-label="Сессия">
      <div class="sheet-grip"></div>
      <h2>🎓 Сессия</h2>
      ${session.start ? `<span class="field-label">Начало: ${esc(fullDate(session.start))}</span>` : ''}
      ${rows ? `<section class="grade-card">${rows}</section>` : '<p class="muted">Предметы и время экзаменов появятся здесь, когда их добавит создатель.</p>'}
    </section>`;
}

function renderSheet() {
  const draft = state.draft;
  if (!draft) return;
  if (draft.type === 'bells') {
    document.getElementById('sheet-root').innerHTML = renderBellsSheet();
    return;
  }
  if (draft.type === 'session') {
    document.getElementById('sheet-root').innerHTML = renderSessionSheet();
    return;
  }
  if (draft.type === 'view-hw') {
    const item = allHomework().find((other) => other.id === draft.id);
    document.getElementById('sheet-root').innerHTML = renderViewHomeworkSheet(item);
    return;
  }
  const subjects = state.data.subjects
    .map((subject) => `<button class="choice ${subject === draft.subject ? 'is-active' : ''}" data-action="draft-subject" data-subject="${esc(subject)}">${esc(subject)}</button>`)
    .join('');
  const options = draft.subject ? nextLessonDates(draft.subject, draft.after, 3) : [];
  const dueChoices = options
    .map((iso, index) => `<button class="choice ${iso === draft.due ? 'is-active' : ''}" data-action="draft-due" data-date="${iso}">${index ? '' : 'След. пара · '}${esc(shortDate(iso))}</button>`)
    .join('');
  document.getElementById('sheet-root').innerHTML = `
    <div class="sheet-back" data-action="close-sheet"></div>
    <section class="sheet" role="dialog" aria-label="Задание">
      <div class="sheet-grip"></div>
      <h2>${draft.id ? 'Задание' : 'Новое задание'}</h2>
      <span class="field-label">Предмет</span>
      <div class="choices choices-scroll">${subjects}</div>
      <label class="field-label" for="hw-text">Что задали</label>
      <textarea class="input" id="hw-text" maxlength="${HW_MAX_TEXT}" placeholder="Например: выучить параграф 4, задачи 1–5">${esc(draft.text)}</textarea>
      <span class="field-label">Срок</span>
      ${dueChoices ? `<div class="choices" style="margin-bottom:8px">${dueChoices}</div>` : ''}
      <input class="input" id="hw-due" type="date" value="${esc(draft.due)}" aria-label="Срок сдачи">
      <div class="sheet-actions">
        <button class="primary" data-action="save-hw">${draft.id ? 'Сохранить' : 'Добавить'}</button>
        ${draft.id ? `<button class="danger-btn" data-action="delete-hw" data-id="${esc(draft.id)}">🗑 Удалить задание</button>` : ''}
      </div>
    </section>`;
  document.querySelector('.choices-scroll .is-active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function keepDraftText() {
  const text = document.getElementById('hw-text');
  const due = document.getElementById('hw-due');
  if (text) state.draft.text = text.value;
  if (due) state.draft.due = due.value;
}

const actions = {
  tab({ tab }) {
    state.tab = tab;
    closeSheet();
    render();
    if (tab === 'schedule') revealSelectedDay();
    window.scrollTo(0, 0);
    haptic();
  },
  'grade-subject'({ index }) {
    state.gradeSubject = Number(index);
    state.gradeFilter = 'all';
    render();
    haptic();
  },
  'grade-filter'({ filter }) {
    state.gradeFilter = filter;
    render();
    haptic();
  },
  session() {
    openSheet({ type: 'session' });
    haptic();
  },
  day({ date }) {
    selectDay(date);
    haptic();
  },
  'cycle-subgroup'() {
    const order = [1, 2, null];
    const current = activeSubgroup();
    state.viewSubgroup = order[(order.indexOf(current) + 1) % order.length];
    render();
    revealSelectedDay();
    haptic();
  },
  'go-today'() {
    const target = defaultDate();
    state.selected = target;
    render();
    revealSelectedDay('smooth');
    haptic();
  },
  bells() {
    openSheet({ type: 'bells' });
    haptic();
  },
  'open-link'({ url }) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (tg?.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  },
  'view-hw'({ id }) {
    openSheet({ type: 'view-hw', id });
    haptic();
  },
  'goto-homework'() {
    state.tab = 'homework';
    closeSheet();
    render();
    window.scrollTo(0, 0);
  },
  'hw-filter'({ filter }) {
    state.hwFilter = filter;
    render();
    haptic();
  },
  'toggle-done'() {
    state.doneOpen = !state.doneOpen;
    render();
    haptic();
  },
  'clear-done'() {
    const targets = state.homework.filter((item) => item.done);
    if (!targets.length) return;
    confirmThen(`Удалить выполненные личные задания (${targets.length})?`, async () => {
      for (const item of targets) await removeHomework(item.id);
      render();
      toast('Выполненные удалены');
    });
  },
  'add-hw'({ subject = '', after }) {
    const from = after ?? mskNow().date;
    const due = subject ? nextLessonDates(subject, from, 1)[0] ?? '' : '';
    openSheet({ id: null, subject, text: '', due, after: from });
  },
  'edit-hw'({ id }) {
    const item = state.homework.find((other) => other.id === id);
    if (item) openSheet({ ...item, after: mskNow().date });
  },
  'draft-subject'({ subject }) {
    keepDraftText();
    state.draft.subject = subject;
    state.draft.due = nextLessonDates(subject, state.draft.after, 1)[0] ?? state.draft.due;
    renderSheet();
    haptic();
  },
  'draft-due'({ date }) {
    keepDraftText();
    state.draft.due = date;
    renderSheet();
  },
  'close-sheet'() {
    closeSheetSafely();
  },
  settings() {
    // Настройки живут в боте: кнопка открывает чат с ним, бот присылает переключатели
    const bot = state.data?.bot;
    if (!bot) {
      toast('Настройки появятся после обновления данных');
      return;
    }
    const link = `https://t.me/${bot}?start=settings`;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(link);
      // Иначе приложение остаётся поверх чата и присланных переключателей не видно
      tg.close();
    } else window.open(link, '_blank');
  },
  async 'save-hw'() {
    keepDraftText();
    const { id, subject, text, due, done } = state.draft;
    if (!subject || !text.trim() || !due) {
      toast('Укажи предмет, задание и срок');
      return;
    }
    const item = { id: id ?? Date.now().toString(36), subject, text: text.trim(), due, done: Boolean(done) };
    closeSheet();
    await saveHomework(item);
    render();
    toast('Сохранено');
  },
  async 'toggle-hw'({ id }) {
    haptic();
    if (id.startsWith('s')) {
      await toggleSharedHomework(id);
    } else {
      const item = state.homework.find((other) => other.id === id);
      if (!item) return;
      await saveHomework({ ...item, done: !item.done });
    }
    render();
  },
  async 'toggle-hw-sheet'({ id }) {
    await actions['toggle-hw']({ id });
    closeSheet();
  },
  'delete-hw'({ id }) {
    confirmThen('Удалить это задание?', async () => {
      closeSheet();
      await removeHomework(id);
      render();
      toast('Удалено');
    });
  },
};

function selectDay(date) {
  if (date === state.selected || !findDay(date)) return;
  const wasDefault = state.selected === defaultDate();
  state.selected = date;
  const isDefault = state.selected === defaultDate();
  if (wasDefault !== isDefault) {
    render();
  } else {
    document.querySelectorAll('.strip-day').forEach((button) => {
      const active = button.dataset.date === date;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active);
    });
    document.getElementById('day-list').innerHTML = renderDayList();
  }
  revealSelectedDay('smooth');
}

function shiftSelectedDay(direction) {
  const today = mskNow().date;
  const days = state.data.days.filter((day) => dateParts(day.date).weekday !== 0 || day.date === today);
  const next = days[days.findIndex((day) => day.date === state.selected) + direction];
  if (next) {
    selectDay(next.date);
    haptic();
  }
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) actions[target.dataset.action]?.(target.dataset);
  });
  let touch = null;
  document.addEventListener('touchstart', (event) => {
    const inList = event.target.closest('#day-list');
    touch = inList ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    if (!touch) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < SWIPE_DISTANCE / 1.5) shiftSelectedDay(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function connectTelegram() {
  const webApp = window.Telegram?.WebApp;
  if (tg || !webApp?.initData) return;
  tg = webApp;
  bindTheme(tg);
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();
  tg.BackButton?.onClick(closeSheetSafely);
  loadHomework().then(render);
  // До загрузки Telegram подгруппа и ключ брались из копии в браузере; CloudStorage точнее
  loadIdentity().finally(loadGrades);
}

async function loadData() {
  const cached = readStorage(DATA_CACHE_KEY);
  if (cached) {
    state.data = cached;
    state.selected = initDay && findDay(initDay) ? initDay : defaultDate();
    render();
    revealSelectedDay();
  }
  try {
    const response = await fetchFresh('data.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.loadFailed = false;
    writeStorage(DATA_CACHE_KEY, state.data);
  } catch {
    state.loadFailed = true;
  }
  if (state.data && initDay && findDay(initDay)) {
    state.selected = initDay;
    initDay = '';
  } else if (state.data && !findDay(state.selected ?? '')) {
    state.selected = defaultDate();
  }
  render();
  revealSelectedDay();
}

function refreshClock() {
  if (!state.data) return;
  const hero = document.getElementById('hero');
  if (hero) hero.innerHTML = renderHero();
}

applyThemeFromUrl();
loadLocalHomework();
bindEvents();
render();
window.onTelegramReady = connectTelegram;
connectTelegram();
loadData();
loadIdentity().finally(loadGrades);
setInterval(refreshClock, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshClock();
});
