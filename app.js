'use strict';

// Весь текст расписания приходит с портала, поэтому в разметку он попадает только через esc()

const DATA_CACHE_KEY = 'tt_data_v1';
const HW_MIRROR_KEY = 'tt_homework_v1';
const HW_PREFIX = 'hw_';
const HW_MAX_TEXT = 3000;
const STALE_MINUTES = 180;
const WIDE_GAP_MINUTES = 40;
const SWIPE_DISTANCE = 60;

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEK_NAMES = { upper: 'верхняя неделя', lower: 'нижняя неделя' };
const STATUS = {
  cancelled: { label: 'не будет', tone: 'danger' },
  remote: { label: 'дистанционно', tone: 'info' },
  replaced: { label: 'замена', tone: 'warn' },
  added: { label: 'новая пара', tone: 'warn' },
  room: { label: 'другая аудитория', tone: 'warn' },
};
const SUBJECT_COLORS = ['#2f7fe0', '#2ea66f', '#d98a00', '#e5484d', '#8e5cf6', '#12a5a5', '#d6409f', '#6b7fd7'];

const subgroup = Number(new URLSearchParams(location.search).get('sg')) || null;

const state = {
  data: null,
  tab: 'schedule',
  selected: null,
  homework: [],
  draft: null,
  loadFailed: false,
};

let tg = null;

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Без кеша приложение просто будет грузиться дольше
  }
}

// В России нет перехода на летнее время, поэтому хватает постоянного сдвига
function mskNow() {
  const shifted = new Date(Date.now() + 3 * 3600 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function dateParts(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return { day: date.getUTCDate(), month: date.getUTCMonth(), weekday: date.getUTCDay() };
}

function addDays(iso, count) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}

function fullDate(iso) {
  const { day, month, weekday } = dateParts(iso);
  return `${WEEKDAYS[weekday]}, ${day} ${MONTHS[month]}`;
}

function shortDate(iso) {
  const { day, month, weekday } = dateParts(iso);
  return `${WEEKDAYS_SHORT[weekday]}, ${day} ${MONTHS[month]}`;
}

function relativeDay(iso) {
  const today = mskNow().date;
  if (iso === today) return 'Сегодня';
  if (iso === addDays(today, 1)) return 'Завтра';
  return null;
}

function plural(count, one, few, many) {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}

function duration(minutes) {
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

function roomLabel(room) {
  return /^\d/.test(room) ? `ауд. ${room}` : room;
}

function subjectColor(subject) {
  let hash = 0;
  for (const ch of subject.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return SUBJECT_COLORS[hash % SUBJECT_COLORS.length];
}

function visible(day) {
  return day.entries.filter((entry) => !subgroup || !entry.subgroup || entry.subgroup === subgroup);
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
      progress: Math.round(((now.minutes - start) / (end - start)) * 100),
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
  };
}

function renderHero() {
  const hero = heroState();
  const timing = hero.left
    ? `<div class="hero-left"><span>${esc(hero.left)}</span><span>${esc(hero.until)}</span></div>`
    : '';
  const bar = hero.progress === undefined ? '' : `<div class="hero-bar"><i style="width:${hero.progress}%"></i></div>`;
  return `
    <p class="hero-eyebrow">${esc(hero.eyebrow)}</p>
    <h2 class="hero-title">${esc(hero.title)}</h2>
    ${hero.meta ? `<p class="hero-meta">${esc(hero.meta)}</p>` : ''}
    ${timing}${bar}`;
}

function freshnessNote() {
  const checked = Date.parse(state.data.checked_at);
  const minutes = Math.max(0, Math.round((Date.now() - checked) / 60000));
  if (minutes < 2) return { text: 'проверено только что', stale: false };
  const age = minutes < 60 ? `${minutes} мин` : minutes < 1440 ? `${Math.round(minutes / 60)} ч` : `${Math.round(minutes / 1440)} дн`;
  return { text: `проверено ${age} назад`, stale: minutes > STALE_MINUTES };
}

function renderHead() {
  const now = mskNow();
  const today = findDay(now.date);
  const note = freshnessNote();
  const chips = [
    today?.week ? `<span class="chip">${WEEK_NAMES[today.week]}</span>` : '',
    subgroup ? `<span class="chip">п/г ${subgroup}</span>` : '',
  ].join('');
  const warning = note.stale || !state.data.portal_ok || state.loadFailed
    ? `<p class="banner">${state.loadFailed ? 'Нет связи, показываю сохранённые данные.' : 'Портал давно не отвечал, свежие замены могут не отображаться.'}</p>`
    : '';
  return `
    <header class="head">
      <h1>${esc(fullDate(now.date))}</h1>
      <div class="head-meta">${chips}<span>${esc(note.text)}</span></div>
      ${warning}
    </header>`;
}

function renderStrip() {
  const today = mskNow().date;
  const days = state.data.days.filter((day) => dateParts(day.date).weekday !== 0 || day.date === today);
  const parts = [];
  days.forEach((day, index) => {
    const { day: number, weekday } = dateParts(day.date);
    if (index && weekday === 1) parts.push('<i class="strip-week"></i>');
    const classes = ['strip-day', day.date === state.selected ? 'is-active' : '', day.date === today ? 'is-today' : ''].join(' ');
    const changed = visible(day).some((entry) => entry.status !== 'normal');
    parts.push(`
      <button class="${classes}" data-action="day" data-date="${day.date}" aria-pressed="${day.date === state.selected}">
        <small>${WEEKDAYS_SHORT[weekday]}</small><b>${number}</b>${changed ? '<i class="dot"></i>' : ''}
      </button>`);
  });
  return `<div class="strip" id="strip">${parts.join('')}</div>`;
}

function homeworkFor(date, subject) {
  return state.homework.filter((item) => item.due === date && item.subject === subject && !item.done);
}

function renderLesson(day, entry, isNow) {
  const status = STATUS[entry.status];
  const pairLabel = entry.pair ? `${entry.pair} пара` : 'Вне сетки';
  const sub = entry.subgroup && !subgroup ? ` · п/г ${entry.subgroup}` : '';
  const tag = status ? `<span class="tag tag-${status.tone}">${status.label}</span>` : '';
  const details = [entry.teacher, roomLabel(entry.room)].filter(Boolean).join(' · ');
  const note = entry.note ? `<p>${esc(entry.note)}</p>` : '';
  const was = entry.was ? `<p>Вместо: ${esc(entry.was)}</p>` : '';
  const tasks = homeworkFor(day.date, entry.subject)
    .map((item) => `<button class="hw-pill" data-action="edit-hw" data-id="${esc(item.id)}">ДЗ: ${esc(item.text)}</button>`)
    .join('');
  const addButton = entry.status === 'cancelled'
    ? ''
    : `<button class="hw-add" data-action="add-hw" data-subject="${esc(entry.subject)}" data-after="${day.date}">+ ДЗ</button>`;
  const classes = ['lesson', entry.status === 'cancelled' ? 'is-cancelled' : '', isNow ? 'is-now' : ''].join(' ');
  return `
    <article class="${classes}">
      <div class="lesson-time"><b>${esc(entry.start)}</b><span>${esc(entry.end)}</span></div>
      <div class="lesson-body" style="--subject:${subjectColor(entry.subject)}">
        <div class="lesson-top"><span>${pairLabel}${sub}</span>${tag}</div>
        <h3>${esc(entry.subject)}</h3>
        ${details ? `<p>${esc(details)}</p>` : ''}${note}${was}
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
  const small = `${number} ${MONTHS[month]}${day.week ? ` · ${WEEK_NAMES[day.week].split(' ')[0]}` : ''}`;
  const heading = `<h2 class="section-title"><span>${esc(title)}</span><small>${esc(small)}</small></h2>`;

  const entries = visible(day);
  if (!entries.length) {
    const reason = day.holiday ? `<strong>${esc(day.holiday)}</strong>Пар нет` : '<strong>Пар нет</strong>Можно выдохнуть';
    return `${heading}<div class="empty">${reason}</div>`;
  }
  const now = mskNow();
  const blocks = [];
  let previousEnd = null;
  for (const entry of entries) {
    const start = toMinutes(entry.start);
    if (previousEnd !== null && start - previousEnd >= WIDE_GAP_MINUTES) {
      blocks.push(`<div class="gap">перерыв ${esc(duration(start - previousEnd))}</div>`);
    }
    const isNow = day.date === now.date && entry.end && entry.status !== 'cancelled'
      && start <= now.minutes && now.minutes < toMinutes(entry.end);
    blocks.push(renderLesson(day, entry, isNow));
    if (entry.status !== 'cancelled' && entry.end) previousEnd = toMinutes(entry.end);
  }
  return `${heading}<div class="lessons">${blocks.join('')}</div>`;
}

function renderSchedule() {
  return `${renderHead()}<section class="hero" id="hero">${renderHero()}</section>${renderStrip()}<div id="day-list">${renderDayList()}</div>`;
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
          <div class="lesson-top"><span>${esc(when)}</span><span class="tag tag-${status.tone}">${status.label}</span></div>
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

function renderHomeworkItem(item) {
  return `
    <article class="hw-item ${item.done ? 'is-done' : ''}">
      <button class="hw-check" data-action="toggle-hw" data-id="${esc(item.id)}" aria-pressed="${item.done}" aria-label="Отметить выполненным">
        <svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7.5"/></svg>
      </button>
      <button class="hw-main" data-action="edit-hw" data-id="${esc(item.id)}">
        <strong>${esc(item.subject)} · ${esc(relativeDay(item.due) ?? shortDate(item.due))}</strong>
        <span>${esc(item.text)}</span>
      </button>
      <button class="hw-remove" data-action="remove-hw" data-id="${esc(item.id)}" aria-label="Удалить">×</button>
    </article>`;
}

function renderHomework() {
  const today = mskNow().date;
  const byDue = (a, b) => a.due.localeCompare(b.due);
  const open = state.homework.filter((item) => !item.done).sort(byDue);
  const late = open.filter((item) => item.due < today);
  const coming = open.filter((item) => item.due >= today);
  const done = state.homework.filter((item) => item.done).sort(byDue).reverse();

  const group = (title, items, extra = '') => items.length
    ? `<h2 class="hw-group ${extra}">${title}</h2>${items.map(renderHomeworkItem).join('')}`
    : '';
  const heading = '<h1 class="section-title" style="margin-top:2px;font-size:25px">Домашка</h1>';
  const empty = state.homework.length ? '' : '<div class="empty"><strong>Пока пусто</strong>Нажми плюс или «+ ДЗ» у пары: срок подставится сам, по следующей паре предмета.</div>';
  return `${heading}${empty}${group('Просрочено', late, 'is-late')}${group('Предстоит', coming)}${group('Сделано', done)}
    <button class="fab" data-action="add-hw" aria-label="Добавить задание">+</button>`;
}

function renderBadges() {
  const today = mskNow().date;
  const counters = {
    'badge-changes': upcomingChanges().reduce((sum, item) => sum + item.entries.length, 0),
    'badge-homework': state.homework.filter((item) => !item.done && item.due <= addDays(today, 1)).length,
  };
  for (const [id, count] of Object.entries(counters)) {
    const badge = document.getElementById(id);
    badge.hidden = !count;
    badge.textContent = count;
  }
}

function render() {
  const view = document.getElementById('view');
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
  renderBadges();
}

function revealSelectedDay(behavior = 'auto') {
  document.querySelector('.strip-day.is-active')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
}

function haptic() {
  try {
    tg?.HapticFeedback?.selectionChanged();
  } catch {
    // Вне Telegram и в старых версиях отклика нет
  }
}

function toast(text) {
  const element = document.getElementById('toast');
  element.textContent = text;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 2600);
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

async function loadHomework() {
  state.homework = readStorage(HW_MIRROR_KEY) ?? [];
  if (!cloud()) return;
  try {
    const keys = (await cloudCall('getKeys')).filter((key) => key.startsWith(HW_PREFIX));
    const values = keys.length ? await cloudCall('getItems', keys) : {};
    state.homework = Object.values(values).filter(Boolean).map((value) => JSON.parse(value));
    writeStorage(HW_MIRROR_KEY, state.homework);
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

function openSheet(draft) {
  state.draft = draft;
  renderSheet();
  tg?.BackButton?.show();
}

function closeSheet() {
  state.draft = null;
  document.getElementById('sheet-root').innerHTML = '';
  tg?.BackButton?.hide();
}

function renderSheet() {
  const draft = state.draft;
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
      <button class="primary" data-action="save-hw">${draft.id ? 'Сохранить' : 'Добавить'}</button>
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
  day({ date }) {
    selectDay(date);
    haptic();
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
    closeSheet();
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
    const item = state.homework.find((other) => other.id === id);
    if (!item) return;
    haptic();
    await saveHomework({ ...item, done: !item.done });
    render();
  },
  async 'remove-hw'({ id }) {
    await removeHomework(id);
    render();
  },
};

function selectDay(date) {
  if (date === state.selected || !findDay(date)) return;
  state.selected = date;
  document.querySelectorAll('.strip-day').forEach((button) => {
    const active = button.dataset.date === date;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active);
  });
  document.getElementById('day-list').innerHTML = renderDayList();
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

// Цвета темы из адреса применяем сразу: скрипт Telegram может загрузиться позже страницы
function applyThemeFromUrl() {
  const theme = new URLSearchParams(location.hash.slice(1)).get('tgWebAppThemeParams');
  if (!theme) return;
  try {
    for (const [name, value] of Object.entries(JSON.parse(theme))) {
      document.documentElement.style.setProperty(`--tg-theme-${name.replaceAll('_', '-')}`, value);
    }
  } catch {
    // Останется оформление по умолчанию
  }
}

function connectTelegram() {
  const webApp = window.Telegram?.WebApp;
  if (tg || !webApp?.initData) return;
  tg = webApp;
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();
  tg.BackButton?.onClick(closeSheet);
  loadHomework().then(render);
}

async function loadData() {
  const cached = readStorage(DATA_CACHE_KEY);
  if (cached) {
    state.data = cached;
    state.selected = defaultDate();
    render();
    revealSelectedDay();
  }
  try {
    const response = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.loadFailed = false;
    writeStorage(DATA_CACHE_KEY, state.data);
  } catch {
    state.loadFailed = true;
  }
  if (state.data && !findDay(state.selected ?? '')) state.selected = defaultDate();
  render();
  revealSelectedDay();
}

function refreshClock() {
  if (!state.data) return;
  const hero = document.getElementById('hero');
  if (hero) hero.innerHTML = renderHero();
}

applyThemeFromUrl();
state.homework = readStorage(HW_MIRROR_KEY) ?? [];
bindEvents();
render();
window.onTelegramReady = connectTelegram;
connectTelegram();
loadData();
setInterval(refreshClock, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshClock();
});
