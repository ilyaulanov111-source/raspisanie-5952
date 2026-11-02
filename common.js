'use strict';

// Общее для приложения и админ-панели. Текст с портала и имена людей попадают в разметку только через esc()

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const SUBJECT_COLORS = ['#2f7fe0', '#2ea66f', '#d98a00', '#e5484d', '#8e5cf6', '#12a5a5', '#d6409f', '#6b7fd7'];

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

// GitHub Pages пересобирает сайт 30–60 секунд после каждого изменения, а API отдаёт новый файл сразу.
// У API лимит 60 запросов в час на адрес, поэтому при отказе берём файл с Pages.
function repositoryOfSite() {
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return owner && repo ? `${owner}/${repo}` : null;
}

async function fetchFresh(name) {
  const stamp = Date.now();
  const repository = repositoryOfSite();
  if (repository) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/contents/${name}?ref=main&t=${stamp}`, {
        headers: { Accept: 'application/vnd.github.raw' },
        cache: 'no-store',
      });
      if (response.ok) return response;
    } catch {
      // Ниже попробуем Pages
    }
  }
  return fetch(`${name}?t=${stamp}`, { cache: 'no-store' });
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
