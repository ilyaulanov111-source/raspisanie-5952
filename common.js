'use strict';

// Общее для приложения и админ-панели. Текст с портала и имена людей попадают в разметку только через esc()

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const SUBJECT_COLORS = ['#2f7fe0', '#2ea66f', '#d98a00', '#e5484d', '#8e5cf6', '#12a5a5', '#d6409f', '#6b7fd7'];

let tg = null;

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>&"]+/g, (raw) => {
    let clean = raw.replace(/[.,;:!?]+$/, '');
    while (clean.endsWith(')') && clean.split('(').length < clean.split(')').length) {
      clean = clean.slice(0, -1).replace(/[.,;:!?]+$/, '');
    }
    const tail = raw.slice(clean.length);
    return `<button type="button" class="inline-link" data-action="open-link" data-url="${clean}">${clean}</button>${tail}`;
  });
}

function confirmThen(text, action) {
  if (tg?.showConfirm && tg.isVersionAtLeast?.('6.2')) tg.showConfirm(text, (ok) => ok && action());
  else if (window.confirm(text)) action();
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

const GH_COOLDOWN_KEY = 'tg_gh_cooldown_until';

async function fetchFresh(name) {
  const stamp = Date.now();
  const repository = repositoryOfSite();
  let cooldown = 0;
  try {
    cooldown = Number(localStorage.getItem(GH_COOLDOWN_KEY) || 0);
  } catch {
    cooldown = 0;
  }
  if (repository && stamp > cooldown) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/contents/${name}?ref=main&t=${stamp}`, {
        headers: { Accept: 'application/vnd.github.raw' },
        cache: 'no-store',
      });
      if (response.ok) return response;
      if (response.status === 403 || response.status === 429) {
        try {
          localStorage.setItem(GH_COOLDOWN_KEY, String(stamp + 15 * 60000));
        } catch {
          // Лимит запомнится только до перезагрузки
        }
      }
    } catch {
      // Ниже попробуем Pages
    }
  }
  return fetch(`${name}?t=${stamp}`, { cache: 'no-store' });
}

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
}

// Личные данные лежат на публичном сайте зашифрованными: AES-256-CTR, первые 8 байт файла начинают счётчик
async function decrypt(buffer, hexKey) {
  const bytes = new Uint8Array(buffer);
  const counter = new Uint8Array(16);
  counter.set(bytes.subarray(0, 8));
  const key = await crypto.subtle.importKey('raw', hexToBytes(hexKey), 'AES-CTR', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, key, bytes.subarray(8));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Цвета и светлая/тёмная тема: синхронизируем с Telegram, но до загрузки скрипта берём параметры из URL
function applyThemeFromUrl() {
  const theme = new URLSearchParams(location.hash.slice(1)).get('tgWebAppThemeParams');
  if (!theme) return;
  try {
    const parsed = JSON.parse(theme);
    for (const [name, value] of Object.entries(parsed)) {
      document.documentElement.style.setProperty(`--tg-theme-${name.replaceAll('_', '-')}`, value);
    }
    if (parsed.bg_color) {
      const hex = parsed.bg_color.replace('#', '');
      if (hex.length === 6) {
        const luma = 0.299 * parseInt(hex.slice(0, 2), 16) + 0.587 * parseInt(hex.slice(2, 4), 16) + 0.114 * parseInt(hex.slice(4, 6), 16);
        document.documentElement.dataset.theme = luma < 128 ? 'dark' : 'light';
      }
    }
  } catch {
    // Останется оформление по умолчанию
  }
}

function applyTelegramTheme(webApp) {
  if (!webApp) return;
  if (webApp.colorScheme) document.documentElement.dataset.theme = webApp.colorScheme;
  if (webApp.themeParams) {
    for (const [name, value] of Object.entries(webApp.themeParams)) {
      document.documentElement.style.setProperty(`--tg-theme-${name.replaceAll('_', '-')}`, value);
    }
  }
}

function bindTheme(webApp) {
  applyTelegramTheme(webApp);
  webApp?.onEvent?.('themeChanged', () => applyTelegramTheme(webApp));
}
