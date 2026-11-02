'use strict';

// Панель создателя. Снимок данных зашифрован, ключ приходит в адресе кнопки из бота.
// Действия уходят боту через sendData: это работает только при запуске кнопкой клавиатуры,
// приложение при этом закрывается, а итог приходит сообщением.

const MAX_ACTION_BYTES = 4096;
const EVENTS_SHOWN = 14;
const DATE_CHOICES = 10;
const KINDS = {
  cancelled: 'Отмена',
  remote: 'Дистанционно',
  replaced: 'Другая пара',
  room: 'Другая аудитория',
};
const STATUS_TITLES = {
  pending: 'Заявки',
  approved: 'С доступом',
  new: 'Заходили, но не просили',
  rejected: 'Отклонённые',
  blocked: 'Заблокированные',
};

const panelKey = new URLSearchParams(location.search).get('k');

const state = {
  tab: 'pulse',
  panel: null,
  schedule: null,
  draft: null,
  failure: '',
  broadcastText: '',
  lastAction: null,
};

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
}

async function decrypt(buffer, hexKey) {
  const bytes = new Uint8Array(buffer);
  const counter = new Uint8Array(16);
  counter.set(bytes.subarray(0, 8));
  const key = await crypto.subtle.importKey('raw', hexToBytes(hexKey), 'AES-CTR', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, key, bytes.subarray(8));
  return JSON.parse(new TextDecoder().decode(plain));
}

function canSend() {
  return Boolean(tg) && !tg.initData;
}

function send(action) {
  const body = JSON.stringify(action);
  state.lastAction = action;
  if (new TextEncoder().encode(body).length > MAX_ACTION_BYTES) {
    toast('Слишком длинный текст, сократи его');
    return;
  }
  if (!canSend()) {
    toast('Открой панель кнопкой 🛠 Админка в боте');
    return;
  }
  haptic();
  tg.sendData(body);
}

function confirmThen(text, action) {
  if (tg?.showConfirm && tg.isVersionAtLeast('6.2')) tg.showConfirm(text, (ok) => ok && action());
  else action();
}

function timeOf(iso) {
  return iso ? iso.slice(11, 16) : '—';
}

function dateLabel(iso) {
  if (!iso) return 'никогда';
  const day = iso.slice(0, 10);
  const relative = relativeDay(day);
  if (relative) return `${relative.toLowerCase()} в ${timeOf(iso)}`;
  const { day: number, month } = dateParts(day);
  return `${number} ${MONTHS[month]}`;
}

function inDays(days) {
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

function usersWith(status) {
  return state.panel.users.filter((user) => user.status === status);
}

function systemStatus() {
  const { portal } = state.panel;
  const pending = usersWith('pending').length;
  if (portal.format_error) return { tone: 'bad', title: 'Портал сменил формат', text: portal.format_error };
  if (portal.failures) {
    const count = `${portal.failures} ${plural(portal.failures, 'проверка', 'проверки', 'проверок')}`;
    return { tone: 'warn', title: 'Портал молчит', text: `${count} подряд без ответа` };
  }
  if (pending) {
    return { tone: 'warn', title: `Заявок: ${pending}`, text: 'Ждут твоего решения во вкладке «Люди»' };
  }
  const next = portal.next_check ? `, следующая проверка ${dateLabel(portal.next_check)}` : '';
  return { tone: 'ok', title: 'Всё спокойно', text: `Портал отвечал ${dateLabel(portal.last_success)}${next}` };
}

function renderStatusCard() {
  const status = systemStatus();
  return `
    <section class="status status-${status.tone}">
      <i class="status-light"></i>
      <div>
        <h2>${esc(status.title)}</h2>
        <p>${esc(status.text)}</p>
      </div>
    </section>`;
}

function portalPercent() {
  const { checks } = state.panel;
  if (!checks.length) return '—';
  return `${Math.round((checks.filter((check) => check.ok).length / checks.length) * 100)}%`;
}

function renderTiles() {
  const { changes, week } = state.panel;
  const tile = (value, label) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  return `<div class="tiles">
    ${tile(usersWith('approved').length, 'с доступом')}
    ${tile(portalPercent(), 'портал отвечает')}
    ${tile(changes.total, 'замен поймано')}
    ${tile(`${week.hours} ч`, `пар на неделе: ${week.pairs}`)}
  </div>`;
}

function renderChecks() {
  const { checks } = state.panel;
  if (!checks.length) return '';
  const ticks = checks.map((check) => `<i class="${check.ok ? 'ok' : 'bad'}" title="${esc(timeOf(check.at))}"></i>`).join('');
  return `<section class="card"><h3>Последние проверки портала</h3><div class="ticks">${ticks}</div></section>`;
}

function renderDanger() {
  const { danger } = state.panel;
  const next = danger.next;
  const when = next
    ? `<p class="danger-when">${esc(inDays(next.in_days))}</p>
       <p>${esc(shortDate(next.date))}, ${next.pair} пара в ${esc(next.start)}</p>`
    : '<p class="danger-when">пока не видно</p>';
  return `
    <section class="danger-card">
      <h3>⚠ До встречи с электротехникой</h3>
      ${when}
      <p class="danger-count">Пережито встреч в семестре: <b>${danger.survived}</b></p>
    </section>`;
}

function uptimeLabel(minutes) {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} дн`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} ч`;
  return `${minutes} мин`;
}

function renderPhone() {
  const { phone, outbox } = state.panel;
  const metric = (value, label) => `<div><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const known = (value, suffix, label) => (value === null ? '' : metric(`${value}${suffix}`, label));
  return `
    <section class="card">
      <h3>Телефон-сервер</h3>
      <div class="metrics">
        ${known(phone.temp_c, '°', 'температура')}
        ${known(phone.ram_free_mb, ' МБ', 'свободно памяти')}
        ${known(phone.disk_free_gb, ' ГБ', 'на диске')}
        ${metric(uptimeLabel(phone.bot_uptime_min), 'бот работает')}
        ${metric(outbox, 'в очереди')}
      </div>
    </section>`;
}

function renderActivity() {
  const { activity } = state.panel;
  const peak = Math.max(1, ...activity.map((item) => item.count));
  const total = activity.reduce((sum, item) => sum + item.count, 0);
  const bars = activity.map((item) => {
    const height = Math.max(4, Math.round((item.count / peak) * 100));
    return `<i style="height:${height}%" title="${esc(item.day)}: ${item.count}"></i>`;
  }).join('');
  return `<section class="card"><h3>Активность за 2 недели <small>${total}</small></h3><div class="bars">${bars}</div></section>`;
}

function renderTopCancelled() {
  const { changes } = state.panel;
  const top = changes.top_cancelled;
  if (!top) return '';
  return `
    <section class="card">
      <h3>Чаще всего отменяют</h3>
      <p class="fame">${esc(top.subject)}</p>
      <p class="muted">${top.count} ${plural(top.count, 'раз', 'раза', 'раз')} · всего отмен: ${changes.cancelled}, дистанционно: ${changes.remote}</p>
    </section>`;
}

function renderGradesCard() {
  const { grades, users, grade_students: students } = state.panel;
  const linked = users.filter((user) => user.grades_name).length;
  const status = grades.error
    ? `<p class="danger-text">${esc(grades.error)}</p>`
    : `<p class="muted">Проверена ${esc(dateLabel(grades.checked_at))}</p>`;
  return `
    <section class="card">
      <h3>Оценки Шульцева <small>связано ${linked} из ${students.length}</small></h3>
      ${status}
      <p class="muted">Свяжи человека со строкой таблицы в его подписи во вкладке «Люди»: он получит /grades и уведомления о новых оценках.</p>
    </section>`;
}

function renderEvents() {
  const events = state.panel.events.slice(0, EVENTS_SHOWN);
  if (!events.length) return '';
  const rows = events.map((event) => `
    <li><time>${esc(event.at.slice(8, 10))}.${esc(event.at.slice(5, 7))} ${esc(timeOf(event.at))}</time><span>${esc(event.text)}</span></li>`).join('');
  return `<section class="card"><h3>Что происходило</h3><ul class="feed">${rows}</ul></section>`;
}

function renderHeading(title) {
  return `
    <header class="head">
      <h1>${esc(title)}</h1>
      <div class="head-meta"><span>снимок: ${esc(dateLabel(state.panel.generated_at))}</span></div>
    </header>`;
}

function renderPulse() {
  return `${renderHeading('Пульт')}${renderStatusCard()}${renderTiles()}
    <button class="primary" data-action="check">🔄 Проверить портал сейчас</button>
    ${renderDanger()}${renderChecks()}${renderGradesCard()}${renderPhone()}${renderActivity()}${renderTopCancelled()}${renderEvents()}`;
}

function renderPerson(user) {
  const isCreator = user.id === state.panel.admin_id;
  const details = [
    user.label ? user.name : null,
    user.username ? `@${user.username}` : 'без ника',
    user.subgroup ? `п/г ${user.subgroup}` : null,
    user.seen_at ? `заходил ${dateLabel(user.seen_at)}` : null,
    `${user.actions} ${plural(user.actions, 'действие', 'действия', 'действий')}`,
    user.grades_name ? `📊 ${user.grades_name}` : null,
    user.remind ? '⏰ напоминания' : null,
    user.active ? null : 'заблокировал бота',
  ].filter(Boolean).join(' · ');
  const decide = (decision, label, tone = '') => `<button class="mini ${tone}" data-action="decide" data-id="${user.id}" data-decision="${decision}" data-name="${esc(user.name)}">${label}</button>`;
  const buttons = {
    pending: decide('approve', '✅ Принять', 'mini-accent') + decide('reject', 'Отклонить') + decide('block', '🚫'),
    approved: decide('revoke', 'Закрыть доступ') + decide('block', '🚫'),
    new: decide('approve', 'Открыть доступ') + decide('block', '🚫'),
    rejected: decide('approve', 'Открыть доступ'),
    blocked: decide('approve', 'Разблокировать'),
  }[user.status];
  const labelButton = `<button class="mini" data-action="label-edit" data-id="${user.id}">🏷 ${user.label ? 'Подпись' : 'Подписать'}</button>`;
  return `
    <article class="person">
      <h3>${esc(user.label || user.name)}${isCreator ? ' <span class="tag tag-info">это ты</span>' : ''}</h3>
      <p>${esc(details)}</p>
      <div class="person-actions">${isCreator ? '' : buttons}${labelButton}</div>
    </article>`;
}

function renderPeople() {
  const sections = Object.keys(STATUS_TITLES).map((status) => {
    const users = usersWith(status);
    if (!users.length) return '';
    return `<h2 class="hw-group">${STATUS_TITLES[status]} · ${users.length}</h2>${users.map(renderPerson).join('')}`;
  });
  return `${renderHeading('Люди')}${sections.join('')}`;
}

function renderHomework() {
  const items = state.panel.homework;
  const today = mskNow().date;
  const rows = items.map((item) => `
    <article class="hw-item admin-hw ${item.due < today ? 'is-done' : ''}">
      <button class="hw-main" data-action="hw-open" data-id="${item.id}">
        <strong>${esc(item.subject)} · ${esc(relativeDay(item.due) ?? shortDate(item.due))}${item.subgroup ? ` · п/г ${item.subgroup}` : ''}</strong>
        <span>${esc(item.text)}</span>
      </button>
      <button class="hw-remove" data-action="hw-delete" data-id="${item.id}" aria-label="Удалить">×</button>
    </article>`).join('');
  const empty = items.length ? '' : '<div class="empty"><strong>Общих заданий нет</strong>Что добавишь здесь, увидят все в приложении.</div>';
  return `${renderHeading('Общее ДЗ')}${empty}${rows}
    <button class="fab" data-action="hw-new" aria-label="Добавить задание">+</button>`;
}

function renderAir() {
  const rows = state.panel.manual.map((item) => `
    <article class="hw-item admin-hw">
      <div class="hw-main">
        <strong>${esc(relativeDay(item.date) ?? shortDate(item.date))} · ${item.pair} пара · ${esc(KINDS[item.kind])}</strong>
        <span>${esc([item.text, item.room].filter(Boolean).join(', ') || 'без пояснения')}</span>
      </div>
      <button class="hw-remove" data-action="manual-delete" data-id="${item.id}" aria-label="Отменить">×</button>
    </article>`).join('');
  return `${renderHeading('Эфир')}
    <section class="card">
      <h3>Объявление всем</h3>
      <textarea class="input" id="broadcast-text" maxlength="1500" placeholder="Например: завтра сбор у 409 в 8:20">${esc(state.broadcastText)}</textarea>
      <button class="primary" data-action="broadcast">📣 Отправить всем</button>
    </section>
    ${renderPolls()}
    ${renderShortDays()}
    <section class="card">
      <h3>Ручные замены</h3>
      <p class="muted">Узнал раньше портала? Добавь сам: все получат уведомление, а в расписании появится пометка.</p>
      ${rows}
      <button class="primary primary-soft" data-action="manual-new">⚡ Добавить замену</button>
    </section>`;
}

function renderPollResult(poll) {
  const total = poll.options.reduce((sum, option) => sum + option.count, 0);
  const rows = poll.options.map((option) => {
    const share = total ? Math.round((option.count / total) * 100) : 0;
    const voters = option.voters.length ? `<small>${esc(option.voters.join(', '))}</small>` : '';
    return `
      <div class="poll-option">
        <div class="poll-line"><span>${esc(option.text)}</span><b>${option.count}</b></div>
        <div class="poll-bar"><i style="width:${share}%"></i></div>
        ${voters}
      </div>`;
  }).join('');
  const close = poll.closed
    ? '<span class="tag tag-safe">закрыт</span>'
    : `<button class="mini" data-action="poll-close" data-id="${poll.id}">Закрыть</button>`;
  return `
    <article class="poll">
      <div class="poll-head"><strong>${esc(poll.question)}</strong>${close}</div>
      <p class="muted">${total} ${plural(total, 'голос', 'голоса', 'голосов')} · ${esc(dateLabel(poll.created_at))}</p>
      ${rows}
    </article>`;
}

function renderPolls() {
  const polls = state.panel.polls.map(renderPollResult).join('');
  return `
    <section class="card">
      <h3>Опросы</h3>
      ${polls || '<p class="muted">Вопрос с вариантами-кнопками: у каждого один голос, итоги видишь здесь.</p>'}
      <button class="primary primary-soft" data-action="poll-new">📊 Новый опрос</button>
    </section>`;
}

function renderShortDays() {
  const rows = state.panel.short_days.map((iso) => `
    <article class="hw-item admin-hw">
      <div class="hw-main"><strong>${esc(relativeDay(iso) ?? shortDate(iso))}</strong><span>Пары по 45 минут</span></div>
      <button class="hw-remove" data-action="short-off" data-date="${iso}" aria-label="Вернуть обычный день">×</button>
    </article>`).join('');
  return `
    <section class="card">
      <h3>Сокращённые дни</h3>
      <p class="muted">Дни перед праздниками бот сокращает сам. Здесь можно сократить любой другой день.</p>
      ${rows}
      <button class="primary primary-soft" data-action="short-new">✂️ Сократить день</button>
    </section>`;
}

function renderBadges() {
  const count = usersWith('pending').length;
  const badge = document.getElementById('badge-people');
  badge.hidden = !count;
  badge.textContent = count;
}

function renderLocked(text) {
  document.getElementById('view').innerHTML = `<div class="locked"><b>🔒</b><h1>Панель закрыта</h1><p>${esc(text)}</p></div>`;
}

function render() {
  if (state.failure) {
    renderLocked(state.failure);
    return;
  }
  if (!state.panel) {
    document.getElementById('view').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    return;
  }
  document.getElementById('tabbar').hidden = false;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
  });
  const screens = { pulse: renderPulse, people: renderPeople, homework: renderHomework, air: renderAir };
  document.getElementById('view').innerHTML = screens[state.tab]();
  renderBadges();
}

function studyDays() {
  const today = mskNow().date;
  return (state.schedule?.days ?? []).filter((day) => day.date >= today && day.entries.length).slice(0, DATE_CHOICES);
}

function lessonDates(subject, subgroup = null) {
  const today = mskNow().date;
  const fits = (entry) => entry.subject === subject && entry.status !== 'cancelled'
    && (!subgroup || !entry.subgroup || entry.subgroup === subgroup);
  return (state.schedule?.days ?? [])
    .filter((day) => day.date > today && day.entries.some(fits))
    .slice(0, 3)
    .map((day) => day.date);
}

// Подгруппы предмета берём из расписания: если пары идут по подгруппам, ДЗ тоже можно дать отдельно
function subjectSubgroups(subject) {
  const found = new Set();
  for (const day of state.schedule?.days ?? []) {
    for (const entry of day.entries) {
      if (entry.subject === subject && entry.subgroup) found.add(entry.subgroup);
    }
  }
  return [...found].sort();
}

function choice(active, action, attributes, label) {
  return `<button class="choice ${active ? 'is-active' : ''}" data-action="${action}" ${attributes}>${esc(label)}</button>`;
}

function renderHomeworkSheet(draft) {
  const subjects = (state.schedule?.subjects ?? [])
    .map((subject) => choice(subject === draft.subject, 'draft-subject', `data-subject="${esc(subject)}"`, subject))
    .join('');
  const dueChoices = (draft.subject ? lessonDates(draft.subject, draft.subgroup) : [])
    .map((iso, index) => choice(iso === draft.due, 'draft-due', `data-date="${iso}"`, `${index ? '' : 'След. пара · '}${shortDate(iso)}`))
    .join('');
  const groups = draft.subject ? subjectSubgroups(draft.subject) : [];
  if (draft.subgroup && !groups.includes(draft.subgroup)) groups.push(draft.subgroup);
  const groupChoices = groups.length
    ? `<span class="field-label">Для кого</span><div class="choices">
        ${choice(!draft.subgroup, 'draft-subgroup', 'data-subgroup="0"', 'Для всех')}
        ${groups.map((group) => choice(draft.subgroup === group, 'draft-subgroup', `data-subgroup="${group}"`, `${group} подгруппа`)).join('')}
      </div>`
    : '';
  return `
    <h2>${draft.id ? 'Изменить задание' : 'Общее задание'}</h2>
    <span class="field-label">Предмет</span>
    <div class="choices choices-scroll">${subjects}</div>
    ${groupChoices}
    <label class="field-label" for="draft-text">Что задали</label>
    <textarea class="input" id="draft-text" maxlength="1500" placeholder="Увидят все в приложении">${esc(draft.text)}</textarea>
    <span class="field-label">Срок</span>
    ${dueChoices ? `<div class="choices" style="margin-bottom:8px">${dueChoices}</div>` : ''}
    <input class="input" id="draft-due" type="date" value="${esc(draft.due)}" aria-label="Срок сдачи">
    <label class="switch"><input type="checkbox" id="draft-notify" ${draft.notify ? 'checked' : ''}><span>${draft.id ? 'Сообщить об изменении в личку' : 'Написать в личку'}</span></label>
    <button class="primary" data-action="hw-save">${draft.id ? 'Сохранить' : 'Добавить'}</button>`;
}

function suggestStudent(label) {
  const words = label.toLowerCase().replaceAll('ё', 'е').split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return '';
  return state.panel.grade_students.find((name) => {
    const target = name.toLowerCase().replaceAll('ё', 'е');
    return words.every((word) => target.includes(word));
  }) ?? '';
}

function renderLabelSheet(draft) {
  const students = state.panel.grade_students;
  const options = students
    .map((name) => `<option value="${esc(name)}" ${name === draft.student ? 'selected' : ''}>${esc(name)}</option>`)
    .join('');
  const grades = students.length
    ? `<label class="field-label" for="draft-student">Строка в таблице оценок</label>
       <select class="input" id="draft-student"><option value="">— не связан —</option>${options}</select>`
    : '<p class="muted">Таблица оценок ещё не загружена.</p>';
  return `
    <h2>Подпись</h2>
    <p class="muted">${esc(draft.name)}. Подпись видишь только ты: в панели и в итогах решений по заявкам.</p>
    <label class="field-label" for="draft-label">Например, имя и фамилия или «староста»</label>
    <input class="input" id="draft-label" maxlength="60" value="${esc(draft.label)}">
    ${grades}
    <button class="primary" data-action="label-save">Сохранить</button>`;
}

function renderPollSheet(draft) {
  const options = draft.options
    .map((option, index) => `<input class="input poll-input" data-option="${index}" maxlength="60" placeholder="Вариант ${index + 1}" value="${esc(option)}">`)
    .join('');
  const more = draft.options.length < 6 ? '<button class="choice" data-action="poll-more">+ вариант</button>' : '';
  return `
    <h2>Новый опрос</h2>
    <label class="field-label" for="draft-question">Вопрос</label>
    <input class="input" id="draft-question" maxlength="200" value="${esc(draft.question)}" placeholder="Например: когда собираемся?">
    <span class="field-label">Варианты</span>
    <div class="poll-inputs">${options}</div>
    ${more}
    <button class="primary" data-action="poll-save">Отправить всем</button>`;
}

function renderShortSheet(draft) {
  const today = mskNow().date;
  const days = (state.schedule?.days ?? [])
    .filter((day) => day.date >= today && day.entries.length && !day.short && dateParts(day.date).weekday !== 6)
    .slice(0, 12);
  const chips = days.map((day) => choice(day.date === draft.date, 'draft-date', `data-date="${day.date}"`, shortDate(day.date))).join('');
  return `
    <h2>Сократить день</h2>
    <p class="muted">Все пары в этот день пойдут по 45 минут, как перед праздником. Каждый получит сообщение с новым временем.</p>
    <span class="field-label">День</span>
    <div class="choices choices-scroll">${chips}</div>
    <button class="primary" data-action="short-save">Сократить и уведомить всех</button>`;
}

function renderManualSheet(draft) {
  const days = studyDays();
  const dateChoices = days
    .map((day) => choice(day.date === draft.date, 'draft-date', `data-date="${day.date}"`, shortDate(day.date)))
    .join('');
  const day = days.find((item) => item.date === draft.date);
  const pairChoices = (day?.entries ?? [])
    .filter((entry) => entry.pair)
    .map((entry) => choice(entry.pair === draft.pair, 'draft-pair', `data-pair="${entry.pair}"`, `${entry.pair} · ${entry.subject}`))
    .join('');
  const kinds = Object.entries(KINDS)
    .map(([kind, label]) => choice(kind === draft.kind, 'draft-kind', `data-kind="${kind}"`, label))
    .join('');
  const textLabel = { cancelled: 'Причина (необязательно)', replaced: 'Какая пара вместо', remote: 'Пояснение (необязательно)' }[draft.kind];
  const needsRoom = draft.kind === 'replaced' || draft.kind === 'room';
  return `
    <h2>Ручная замена</h2>
    <span class="field-label">День</span>
    <div class="choices choices-scroll">${dateChoices}</div>
    <span class="field-label">Пара</span>
    <div class="choices choices-column">${pairChoices || '<p class="muted">В этот день пар нет</p>'}</div>
    <span class="field-label">Что случилось</span>
    <div class="choices">${kinds}</div>
    ${textLabel ? `<label class="field-label" for="draft-text">${textLabel}</label><input class="input" id="draft-text" maxlength="200" value="${esc(draft.text)}">` : ''}
    ${needsRoom ? `<label class="field-label" for="draft-room">Аудитория</label><input class="input" id="draft-room" maxlength="60" value="${esc(draft.room)}">` : ''}
    <button class="primary" data-action="manual-save">Добавить и уведомить всех</button>`;
}

function renderSheet() {
  const renderers = {
    homework: renderHomeworkSheet,
    manual: renderManualSheet,
    label: renderLabelSheet,
    poll: renderPollSheet,
    short: renderShortSheet,
  };
  const content = renderers[state.draft.type](state.draft);
  document.getElementById('sheet-root').innerHTML = `
    <div class="sheet-back" data-action="close-sheet"></div>
    <section class="sheet" role="dialog"><div class="sheet-grip"></div>${content}</section>`;
  document.querySelectorAll('.choices-scroll .is-active').forEach((item) => item.scrollIntoView({ inline: 'center', block: 'nearest' }));
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

function keepDraft() {
  const field = (id) => document.getElementById(id);
  if (field('draft-text')) state.draft.text = field('draft-text').value;
  if (field('draft-due')) state.draft.due = field('draft-due').value;
  if (field('draft-room')) state.draft.room = field('draft-room').value;
  if (field('draft-notify')) state.draft.notify = field('draft-notify').checked;
  if (field('draft-label')) state.draft.label = field('draft-label').value;
  if (field('draft-student')) state.draft.student = field('draft-student').value;
  if (field('draft-question')) state.draft.question = field('draft-question').value;
  document.querySelectorAll('.poll-input').forEach((input) => {
    state.draft.options[Number(input.dataset.option)] = input.value;
  });
}

function updateDraft(change) {
  keepDraft();
  Object.assign(state.draft, change);
  renderSheet();
  haptic();
}

const actions = {
  tab({ tab }) {
    state.broadcastText = document.getElementById('broadcast-text')?.value ?? state.broadcastText;
    state.tab = tab;
    closeSheet();
    render();
    window.scrollTo(0, 0);
    haptic();
  },
  check() {
    send({ a: 'check' });
  },
  decide({ id, decision, name }) {
    const questions = {
      revoke: `Закрыть доступ: ${name}?`,
      block: `Заблокировать: ${name}?`,
    };
    const run = () => send({ a: 'user', id: Number(id), decision });
    if (questions[decision]) confirmThen(questions[decision], run);
    else run();
  },
  'hw-new'() {
    openSheet({ type: 'homework', id: null, subject: '', text: '', due: '', subgroup: null, notify: true });
  },
  'hw-open'({ id }) {
    const item = state.panel.homework.find((other) => other.id === Number(id));
    if (item) openSheet({ type: 'homework', ...item, subgroup: item.subgroup || null, notify: false });
  },
  'draft-subject'({ subject }) {
    const subgroup = subjectSubgroups(subject).includes(state.draft.subgroup) ? state.draft.subgroup : null;
    updateDraft({ subject, subgroup, due: lessonDates(subject, subgroup)[0] ?? '' });
  },
  'draft-subgroup'({ subgroup }) {
    const value = Number(subgroup) || null;
    updateDraft({ subgroup: value, due: lessonDates(state.draft.subject, value)[0] ?? state.draft.due });
  },
  'label-edit'({ id }) {
    const user = state.panel.users.find((other) => other.id === Number(id));
    if (!user) return;
    const student = user.grades_name || suggestStudent(user.label || user.name);
    openSheet({ type: 'label', id: user.id, name: user.name, label: user.label ?? '', student });
  },
  'label-save'() {
    keepDraft();
    const action = { a: 'user_label', id: state.draft.id, label: state.draft.label.trim() };
    if (state.panel.grade_students.length) action.student = state.draft.student;
    send(action);
  },
  'poll-new'() {
    openSheet({ type: 'poll', question: '', options: ['', ''] });
  },
  'poll-more'() {
    keepDraft();
    state.draft.options.push('');
    renderSheet();
  },
  'poll-save'() {
    keepDraft();
    const options = state.draft.options.map((option) => option.trim()).filter(Boolean);
    if (!state.draft.question.trim() || options.length < 2) {
      toast('Нужен вопрос и хотя бы два варианта');
      return;
    }
    send({ a: 'poll_new', question: state.draft.question.trim(), options });
  },
  'poll-close'({ id }) {
    confirmThen('Закрыть опрос? Голосовать больше будет нельзя.', () => send({ a: 'poll_close', id: Number(id) }));
  },
  'short-new'() {
    openSheet({ type: 'short', date: '' });
  },
  'short-save'() {
    if (!state.draft.date) {
      toast('Выбери день');
      return;
    }
    send({ a: 'short_day', date: state.draft.date, on: true });
  },
  'short-off'({ date }) {
    confirmThen('Вернуть обычное расписание на этот день?', () => send({ a: 'short_day', date, on: false }));
  },
  'draft-due'({ date }) {
    updateDraft({ due: date });
  },
  'hw-save'() {
    keepDraft();
    const { id, subject, text, due, notify, subgroup } = state.draft;
    if (!subject || !text.trim() || !due) {
      toast('Укажи предмет, задание и срок');
      return;
    }
    const fields = { subject, text: text.trim(), due, notify, subgroup: subgroup || 0 };
    send(id ? { a: 'hw_edit', id, ...fields } : { a: 'hw_add', ...fields });
  },
  'hw-delete'({ id }) {
    confirmThen('Удалить это задание у всех?', () => send({ a: 'hw_del', id: Number(id) }));
  },
  'manual-new'() {
    const first = studyDays()[0];
    openSheet({ type: 'manual', date: first?.date ?? '', pair: null, kind: 'cancelled', text: '', room: '' });
  },
  'draft-date'({ date }) {
    updateDraft({ date, pair: null });
  },
  'draft-pair'({ pair }) {
    updateDraft({ pair: Number(pair) });
  },
  'draft-kind'({ kind }) {
    updateDraft({ kind, text: '', room: '' });
  },
  'manual-save'() {
    keepDraft();
    const { date, pair, kind, text, room } = state.draft;
    if (!date || !pair) {
      toast('Выбери день и пару');
      return;
    }
    send({ a: 'manual_add', date, pair, kind, text: text.trim(), room: room.trim() });
  },
  'manual-delete'({ id }) {
    confirmThen('Отменить замену и уведомить всех?', () => send({ a: 'manual_del', id: Number(id) }));
  },
  broadcast() {
    const text = document.getElementById('broadcast-text').value.trim();
    if (!text) {
      toast('Напиши текст объявления');
      return;
    }
    confirmThen('Отправить объявление всем?', () => send({ a: 'broadcast', text }));
  },
  'close-sheet'() {
    closeSheet();
  },
};

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) actions[target.dataset.action]?.(target.dataset);
  });
}

function connectTelegram() {
  const webApp = window.Telegram?.WebApp;
  if (tg || !webApp || webApp.platform === 'unknown') return;
  tg = webApp;
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();
  tg.BackButton?.onClick(closeSheet);
}

async function loadPanel() {
  if (!/^[0-9a-f]{64}$/.test(panelKey ?? '')) {
    state.failure = 'Она открывается только кнопкой в боте.';
    render();
    return;
  }
  try {
    const [blob, schedule] = await Promise.all([fetchFresh('admin.bin'), fetchFresh('data.json')]);
    if (!blob.ok) throw new Error(`HTTP ${blob.status}`);
    state.panel = await decrypt(await blob.arrayBuffer(), panelKey);
    state.schedule = schedule.ok ? await schedule.json() : null;
  } catch {
    state.failure = 'Не удалось открыть данные. Проверь интернет или запроси кнопку заново командой /admin.';
  }
  render();
}

applyThemeFromUrl();
bindEvents();
render();
window.onTelegramReady = connectTelegram;
connectTelegram();
loadPanel();
