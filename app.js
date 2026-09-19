'use strict';

/* ===== Констансты и утилиты ===== */

const API = 'https://api.opendota.com/api';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com';
const PAGE_SIZE = 500;    // матчей на страницу (двигаем offset на длину ответа)
const HARD_CAP = 10000;   // предохранитель для «вся история»
const RENDER_CHUNK = 150; // сколько матчей рендерим за раз

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDuration = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

const GAME_MODES = {
  0: 'Неизвестный', 1: 'All Pick', 2: "Captain's Mode", 3: 'Random Draft', 4: 'Single Draft',
  5: 'All Random', 6: 'Обучение', 7: "Captain's Mode", 8: 'Reverse CM', 9: 'Greeviling',
  10: 'Обучение', 11: 'Mid Only', 12: 'Least Played', 13: 'Limited Heroes', 14: 'Compassion',
  15: 'Кастомный', 16: "Captain's Draft", 17: 'Balanced Draft', 18: 'Ability Draft',
  19: 'Событие', 20: 'All Random DM', 21: '1v1 Mid', 22: 'Ranked All Pick', 23: 'Turbo',
  24: 'Mutation', 25: 'Событие',
};

const RANK_NAMES = ['Рекрут', 'Страж', 'Рыцарь', 'Герой', 'Легенда', 'Властелин', 'Божество', 'Титан'];

function rankName(tier) {
  if (!tier) return '';
  const i = Math.floor(tier / 10) - 1;
  if (i < 0 || i > 7) return '';
  return i === 7 ? RANK_NAMES[7] : `${RANK_NAMES[i]} ${tier % 10}`;
}

/* Официальные иконки медалей (icons/, Dota 2 Wiki).
 * Титанам из таблицы лидеров — соответствующая топ-иконка. */
function medalUrl(tier, lb) {
  if (tier >= 80) {
    if (lb != null && lb <= 10) return 'icons/medal-top4.webp';
    if (lb != null && lb <= 100) return 'icons/medal-top3.webp';
    if (lb != null && lb <= 1000) return 'icons/medal-top2.webp';
    return 'icons/medal-top0.webp';
  }
  const i = Math.floor(tier / 10);
  if (i < 1 || i > 7) return 'icons/medal-0-0.webp';
  return `icons/medal-${i}-${Math.max(1, tier % 10)}.webp`;
}

/* ===== Работа с OpenDota API (лимит ~60 запросов/мин) ===== */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* Токен-ведро: стартовый запас 8 запросов, дальше ~1 запрос в секунду */
const bucket = { tokens: 8, cap: 8, refillMs: 1050, last: Date.now() };

async function takeToken() {
  for (;;) {
    const now = Date.now();
    const add = Math.floor((now - bucket.last) / bucket.refillMs);
    if (add > 0) {
      bucket.tokens = Math.min(bucket.cap, bucket.tokens + add);
      bucket.last += add * bucket.refillMs;
    }
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }
    await sleep(Math.max(100, bucket.last + bucket.refillMs - Date.now()));
  }
}

/* Все запросы выполняются строго по очереди */
let fetchSeq = Promise.resolve();

function apiGet(path, signal) {
  const run = async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw abortError();
      await takeToken();
      try {
        const res = await fetch(API + path, { signal });
        if (res.ok) return res.json();
        if (res.status === 429 || res.status >= 500) {
          lastErr = new ApiError(res.status, res.status === 429
            ? 'Превышен лимит запросов к OpenDota API — подождите минуту и попробуйте снова.'
            : `OpenDota API вернул ошибку ${res.status}. Попробуйте позже.`);
          await sleep(res.status === 429 ? 20000 : 4000);
          continue;
        }
        throw new ApiError(res.status, res.status === 404
          ? 'Профиль не найден в OpenDota. Проверьте ID.'
          : `OpenDota API вернул ошибку ${res.status}. Попробуйте позже.`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e instanceof ApiError && e.status !== 429 && e.status < 500) throw e;
        lastErr = e;
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastErr ?? new Error('Не удалось связаться с OpenDota API');
  };
  const result = fetchSeq.then(run, run);
  fetchSeq = result.catch(() => {});
  return result;
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function friendlyError(e) {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return 'Нет соединения с OpenDota API. Проверьте интернет.';
  return e?.message || 'Что-то пошло не так';
}

/* ===== Разбор ID ===== */

const STEAM64_BASE = 76561197960265728n;

function parseAccountId(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/(?:players|profiles)\/(\d{4,20})/i)
    || s.match(/\bU:1:(\d{1,12})\b/)
    || s.match(/(\d{4,20})/);
  if (!m) return null;
  let n;
  try { n = BigInt(m[1]); } catch { return null; }
  if (n >= STEAM64_BASE && n < 76561200000000000n) n -= STEAM64_BASE;
  if (n <= 0n || n >= 4294967296n) return null;
  return Number(n);
}

/* ===== Загрузка данных ===== */

const HEROES_CACHE_KEY = 'd2e-heroes-v1';

function heroImgUrl(npcName) {
  return `${STEAM_CDN}/apps/dota2/images/dota_react/heroes/${npcName.replace(/^npc_dota_hero_/, '')}.png`;
}

async function loadHeroes(signal) {
  try {
    const cached = JSON.parse(localStorage.getItem(HEROES_CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.t < 14 * 86400000 && Array.isArray(cached.d) && cached.d.length > 100) {
      return new Map(cached.d.map((h) => [h.id, h]));
    }
  } catch { /* ignore */ }
  const list = await apiGet('/heroes', signal);
  try { localStorage.setItem(HEROES_CACHE_KEY, JSON.stringify({ t: Date.now(), d: list })); } catch { /* ignore */ }
  return new Map(list.map((h) => [h.id, h]));
}

async function loadProfile(id, signal) {
  const p = await apiGet(`/players/${id}`, signal);
  const tier = p?.rank_tier ?? null;
  return {
    id,
    name: p?.profile?.personaname || `Игрок ${id}`,
    avatar: p?.profile?.avatarmedium || p?.profile?.avatar || '',
    tier,
    lb: p?.leaderboard_rank ?? null,
    rank: rankName(tier),
  };
}

/* Сводка «сколько игр вместе» из списка частых напарников */
async function fetchPeersSummary(a, b, signal) {
  const peers = await apiGet(`/players/${a}/peers`, signal);
  if (!Array.isArray(peers)) return null;
  return peers.find((p) => p.account_id === b) ?? null;
}

/*
 * Скачивает историю матчей игрока в store (Map match_id → матч).
 * Размер страницы ненадёжен (иногда сервер отдаёт меньше), поэтому
 * offset двигаем на длину ответа и останавливаемся только по пустой странице.
 * Возвращает true, если остановились из-за ограничения глубины.
 */
async function scanHistory(store, accountId, { insignif, max, maxPages, signal, onPage }) {
  let offset = 0;
  let capped = false;
  let pages = 0;
  const limit = max != null && max < PAGE_SIZE ? max : PAGE_SIZE;

  for (;;) {
    if (signal?.aborted) throw abortError();
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (insignif) params.set('significant', '0');
    const page = await apiGet(`/players/${accountId}/matches?${params}`, signal);
    if (!Array.isArray(page) || page.length === 0) break;

    const before = store.size;
    for (const m of page) if (m.match_id != null) store.set(m.match_id, m);
    offset += page.length;
    pages++;
    onPage?.(store.size);

    if (max != null && store.size >= max) break; // достигнута выбранная глубина — это не обрезка
    if (maxPages != null && pages >= maxPages) { capped = true; break; }
    if (store.size >= HARD_CAP) { capped = true; break; }
    if (store.size === before) break; // защита от зацикливания
  }
  return capped;
}

/* ===== Сравнение историй ===== */

function teamOf(slot) { return slot < 128 ? 0 : 1; }

function buildEncounters(mapMe, mapOther) {
  const list = [];
  for (const [matchId, me] of mapMe) {
    const other = mapOther.get(matchId);
    if (!other) continue;
    const myTeam = teamOf(me.player_slot);
    const otherTeam = teamOf(other.player_slot);
    let result = null;
    if (typeof me.radiant_win === 'boolean') {
      result = (me.radiant_win ? 0 : 1) === myTeam ? 'win' : 'loss';
    }
    list.push({
      matchId,
      startTime: me.start_time,
      duration: me.duration,
      together: myTeam === otherTeam,
      result,
      mode: me.game_mode,
      lobby: me.lobby_type,
      me: { hero: me.hero_id, k: me.kills, d: me.deaths, a: me.assists, party: me.party_size },
      other: { hero: other.hero_id, k: other.kills, d: other.deaths, a: other.assists },
    });
  }
  list.sort((x, y) => y.startTime - x.startTime);
  return list;
}

/* ===== Рендер ===== */

function showError(msg) {
  const b = $('#error-box');
  b.textContent = msg;
  b.hidden = false;
}

function hideError() { $('#error-box').hidden = true; }

function showStatus(title) {
  $('#status').hidden = false;
  $('#status-title').textContent = title;
  $('#status-sub').textContent = '';
  $('#live-found').textContent = '';
}

function hideStatus() { $('#status').hidden = true; }

function setBusy(busy) {
  $('#submit-btn').disabled = busy;
  $('#match-btn').disabled = busy;
  $('#crew-btn').disabled = busy;
  document.querySelectorAll('.cancel-btn').forEach((b) => { b.hidden = !busy; });
  if (!busy) hideStatus();
}

function profileHtml(p) {
  const initial = esc((p.name || '?').slice(0, 1).toUpperCase());
  const av = p.avatar
    ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" onerror="this.remove()">`
    : initial;
  const medal = p.tier ? `<img class="medal" src="${medalUrl(p.tier, p.lb)}" alt="" onerror="this.remove()">` : '';
  return `
    <div class="avatar">${av}</div>
    <div class="p-info">
      <a href="https://www.opendota.com/players/${p.id}" target="_blank" rel="noopener">${esc(p.name)}</a>
      ${p.rank ? `<span class="rank">${medal}${esc(p.rank)}</span>` : ''}
      <span class="muted">ID ${p.id}</span>
    </div>`;
}

function renderProfiles(pa, pb) {
  const box = $('#profiles');
  box.hidden = false;
  box.innerHTML = `
    <div class="profile card">${profileHtml(pa)}</div>
    <div class="p-vs" aria-hidden="true">⚔️</div>
    <div class="profile card">${profileHtml(pb)}</div>`;
}

function heroHtml(h, kda) {
  const name = h ? esc(h.localized_name) : 'Герой';
  const img = h
    ? `<img class="hero" src="${esc(heroImgUrl(h.name))}" alt="" loading="lazy" onerror="this.classList.add('noimg')">`
    : '';
  const kdaHtml = kda && kda.k != null
    ? `<span class="kda">${kda.k}/<span class="deaths">${kda.d}</span>/${kda.a}</span>`
    : '';
  return `${img}<div class="m-pinfo"><b>${name}</b>${kdaHtml}</div>`;
}

function matchRow(x, heroes) {
  const d = new Date(x.startTime * 1000);
  const mode = GAME_MODES[x.mode] || `Режим ${x.mode ?? '?'}`;
  const resCls = x.result ?? 'unknown';
  const resText = x.result === 'win' ? 'Победа' : x.result === 'loss' ? 'Поражение' : 'нет данных';
  const li = document.createElement('li');
  li.className = `match ${x.together ? 'together' : 'against'}`;
  li.innerHTML = `
    <div class="m-date"><b>${fmtDate.format(d)}</b><span>${fmtTime.format(d)}</span></div>
    <div class="m-player me">${heroHtml(heroes.get(x.me.hero), x.me)}</div>
    <div class="m-mid">
      <span class="rel ${x.together ? 't' : 'v'}">${x.together ? 'в одной команде' : 'друг против друга'}</span>
      <span class="res ${resCls}">${resText}</span>
    </div>
    <div class="m-player other">${heroHtml(heroes.get(x.other.hero), x.other)}</div>
    <div class="m-meta"><b>${fmtDuration(x.duration ?? 0)}</b><span>${esc(mode)}</span></div>
    <a class="m-link" href="https://www.opendota.com/matches/${x.matchId}" target="_blank" rel="noopener">OpenDota ↗</a>`;
  return li;
}

let renderState = null;

function renderMatches(enc, heroes) {
  const ol = $('#matches');
  ol.innerHTML = '';
  renderState = { enc, heroes, shown: 0 };
  appendChunk();
}

function appendChunk() {
  if (!renderState) return;
  const { enc, heroes, shown } = renderState;
  const ol = $('#matches');
  const frag = document.createDocumentFragment();
  const end = Math.min(enc.length, shown + RENDER_CHUNK);
  for (let i = shown; i < end; i++) frag.appendChild(matchRow(enc[i], heroes));
  ol.appendChild(frag);
  renderState.shown = end;
  const btn = $('#more-btn');
  btn.hidden = end >= enc.length;
  if (!btn.hidden) {
    const rest = enc.length - end;
    btn.textContent = `Показать ещё — осталось ${rest} ${plural(rest, ['матч', 'матча', 'матчей'])}`;
  }
}

function renderSummary(enc, ctx) {
  const { peer, depth, capped } = ctx;
  const box = $('#summary');

  if (enc.length === 0) {
    const untracked = ctx.scannedA === 0 || ctx.scannedB === 0;
    const who = [ctx.scannedA === 0 ? ctx.pa.name : null, ctx.scannedB === 0 ? ctx.pb.name : null]
      .filter(Boolean)
      .join(' и ');
    box.innerHTML = `
      <div class="card empty" style="flex:1 1 100%">
        <div class="big">🧭</div>
        <h2>Общих матчей не найдено</h2>
        <p>${untracked
          ? `У ${who} в OpenDota нет матчей — аккаунт не отслеживается сервисом. Откройте профиль на opendota.com, чтобы добавить его.`
          : 'В просмотренной истории совместных игр не нашлось. Попробуйте увеличить глубину поиска или включить матчи с ботами и кастомные режимы.'}</p>
      </div>`;
    return;
  }

  const together = enc.filter((x) => x.together);
  const against = enc.filter((x) => !x.together);
  const winT = together.filter((x) => x.result === 'win').length;
  const winA = against.filter((x) => x.result === 'win').length;
  const first = new Date(enc[enc.length - 1].startTime * 1000);
  const last = new Date(enc[0].startTime * 1000);

  const notes = [];
  if (ctx.scannedA === 0 || ctx.scannedB === 0) {
    const who = [ctx.scannedA === 0 ? ctx.pa.name : null, ctx.scannedB === 0 ? ctx.pb.name : null]
      .filter(Boolean)
      .join(' и ');
    notes.push(`У ${who} в OpenDota нет матчей — аккаунт не отслеживается сервисом, поэтому поиск ничего не найдёт. Откройте профиль на opendota.com, чтобы добавить его.`);
  }
  if (peer) {
    notes.push(`Сводка OpenDota за всё время: вместе — ${peer.with_games ?? 0} ${plural(peer.with_games ?? 0, ['игра', 'игры', 'игр'])} (${peer.with_win ?? 0} побед), на разных сторонах — ${peer.against_games ?? 0} (${peer.against_win ?? 0} побед на вашей стороне).`);
  }
  if (depth != null) notes.push(`Поиск ограничен ~${depth} последними матчами каждого игрока.`);
  if (capped) notes.push('История оказалась очень длинной — просмотрено не больше 10 000 матчей каждого.');

  box.innerHTML = `
    <div class="stat total">
      <div class="value">${enc.length}</div>
      <div class="label">${plural(enc.length, ['встреча', 'встречи', 'встреч'])} всего</div>
      <div class="sub muted">с ${fmtDate.format(first)}<br>по ${fmtDate.format(last)}</div>
    </div>
    <div class="stat together">
      <div class="value">${together.length}</div>
      <div class="label">в одной команде</div>
      <div class="sub muted">${winT} ${plural(winT, ['победа', 'победы', 'побед'])}${together.length ? ` · ${Math.round((winT / together.length) * 100)}% винрейт` : ''}</div>
    </div>
    <div class="stat against">
      <div class="value">${against.length}</div>
      <div class="label">друг против друга</div>
      <div class="sub muted">${winA} ${plural(winA, ['ваша победа', 'ваши победы', 'ваших побед'])}${against.length ? ` · ${Math.round((winA / against.length) * 100)}%` : ''}</div>
    </div>
    <div class="stat">
      <div class="value" style="font-size:20px;padding-top:5px">${fmtDate.format(last)}</div>
      <div class="label">последняя встреча</div>
    </div>
    ${notes.length ? `<div class="summary-notes">${notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : ''}`;
}

function renderResult(enc, ctx) {
  renderSummary(enc, ctx);
  $('#matches-head').innerHTML = enc.length
    ? `<h2>Найдено ${enc.length} ${plural(enc.length, ['встреча', 'встречи', 'встреч'])}</h2><span class="muted">сначала недавние · победа/поражение — с вашей точки зрения</span>`
    : '';
  tabState.players = true;
  $('#result').hidden = false;
  renderMatches(enc, ctx.heroes);
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===== Поиск ===== */

let currentAbort = null;

async function runSearch(a, b, { depth, insignif }) {
  currentAbort?.abort();
  const ctrl = new AbortController();
  currentAbort = ctrl;
  const { signal } = ctrl;

  setBusy(true);
  hideError();
  tabState.players = false;
  $('#profiles').hidden = true;
  $('#result').hidden = true;
  $('#match-result').hidden = true;
  $('#crew-result').hidden = true;
  showStatus('Загружаю профили…');

  try {
    let heroes, pa, pb;
    try {
      [heroes, pa, pb] = await Promise.all([
        loadHeroes(signal),
        loadProfile(a, signal),
        loadProfile(b, signal),
      ]);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(friendlyError(e));
    }

    renderProfiles(pa, pb);
    rememberId(a, pa.name);

    // Прежде чем что-то сканировать, дёшево проверяем обе истории:
    // закрытая (404) — стоп с ошибкой, пустая — стоп без поиска,
    // иначе не тратим сотни запросов на сканирование второго игрока.
    showStatus('Проверяю доступность историй матчей…');
    const probeOne = async (id, name) => {
      try {
        const page = await apiGet(`/players/${id}/matches?limit=1`, signal);
        if (!Array.isArray(page)) return { state: 'closed', name };
        return { state: page.length ? 'ok' : 'empty', name };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { state: 'closed', name };
        throw e;
      }
    };
    const [histA, histB] = await Promise.all([probeOne(a, pa.name), probeOne(b, pb.name)]);

    const closed = [histA, histB].filter((h) => h.state === 'closed').map((h) => h.name);
    if (closed.length) {
      throw new ApiError(403, `История матчей игрока «${closed.join(' и ')}» закрыта — профиль скрыт настройками приватности или не отслеживается OpenDota. Для поиска встреч история нужна открытой у обоих игроков.`);
    }
    const emptyHist = [histA, histB].filter((h) => h.state === 'empty').map((h) => h.name);
    if (emptyHist.length) {
      renderResult([], {
        pa, pb, peer: null, heroes, depth, capped: false,
        scannedA: histA.state === 'empty' ? 0 : 1,
        scannedB: histB.state === 'empty' ? 0 : 1,
      });
      return;
    }

    // Сводка из /peers — только для заметки: эндпоинт отдаёт топ-200 напарников,
    // поэтому отсутствие в нём ничего не говорит — всегда сканируем истории.
    const peer = await fetchPeersSummary(a, b, signal).catch(() => null);

    showStatus('Сканирую истории матчей…');
    if (peer) $('#status-sub').textContent = 'По сводке OpenDota вы уже встречались — ищу матчи…';

    const maps = { a: new Map(), b: new Map() };
    const counts = { a: 0, b: 0 };
    const onPage = (key) => (size) => {
      counts[key] = size;
      $('#status-sub').textContent = `${pa.name}: ${counts.a} · ${pb.name}: ${counts.b} (просмотрено матчей)`;
      let n = 0;
      for (const id of maps.a.keys()) if (maps.b.has(id)) n++;
      $('#live-found').textContent = n > 0
        ? `Уже найдено общих: ${n}`
        : 'Совпадений пока нет…';
    };

    const [cappedA, cappedB] = await Promise.all([
      scanHistory(maps.a, a, { insignif, max: depth, signal, onPage: onPage('a') }),
      scanHistory(maps.b, b, { insignif, max: depth, signal, onPage: onPage('b') }),
    ]);

    const enc = buildEncounters(maps.a, maps.b);
    renderResult(enc, {
      pa, pb, peer, heroes, depth,
      capped: cappedA || cappedB,
      scannedA: maps.a.size,
      scannedB: maps.b.size,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (ctrl === currentAbort) {
        setBusy(false);
        showError('Поиск отменён.');
      }
      return;
    }
    showError(friendlyError(e));
  } finally {
    if (ctrl === currentAbort) {
      setBusy(false);
      currentAbort = null;
    }
  }
}

/* ===== Разбор матча ===== */

let matchMyId = null;

function parseMatchId(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 && Number.isSafeInteger(n) ? n : null;
  }
  const m = s.match(/matches\/(\d{6,15})/i);
  return m ? Number(m[1]) : null;
}

function renderMatchHead(m, heroes, myId) {
  const d = new Date((m.start_time ?? 0) * 1000);
  const mode = GAME_MODES[m.game_mode] || `Режим ${m.game_mode ?? '?'}`;
  const mine = m.players.find((p) => p.account_id === myId);
  let score = '';
  let res = '';
  if (typeof m.radiant_win === 'boolean') {
    const rk = m.players.filter((p) => p.player_slot < 128).reduce((s, p) => s + (p.kills || 0), 0);
    const dk = m.players.filter((p) => p.player_slot >= 128).reduce((s, p) => s + (p.kills || 0), 0);
    score = `<span class="score">${rk} : ${dk}</span>`;
    if (mine) {
      const win = (m.radiant_win ? 0 : 1) === teamOf(mine.player_slot);
      res = `<span class="res ${win ? 'win' : 'loss'}">${win ? 'Победа' : 'Поражение'}</span>`;
    }
  }
  $('#match-card').innerHTML = `
    ${res}<b>${esc(mode)}</b>${score}
    <span class="muted">${fmtDate.format(d)} · ${fmtTime.format(d)} · ${fmtDuration(m.duration ?? 0)}</span>
    <a class="m-link" href="https://www.opendota.com/matches/${m.match_id}" target="_blank" rel="noopener">OpenDota ↗</a>`;
}

function matchPlayerRow(p, enc, closed, heroes, mySlot) {
  const h = heroes.get(p.hero_id);
  const name = p.personaname || `Игрок ${p.account_id}`;
  const ally = mySlot != null && teamOf(p.player_slot) === teamOf(mySlot);
  const side = mySlot == null
    ? ''
    : ally ? '<span class="rel t">союзник в матче</span>' : '<span class="rel v">соперник в матче</span>';
  const encHtml = closed
    ? '<b class="muted">история матчей закрыта</b>'
    : enc.length
      ? `<b>${enc.filter((x) => x.together).length} вместе · ${enc.filter((x) => !x.together).length} против · всего ${enc.length}</b>
         <span>последняя: ${fmtDate.format(new Date(enc[0].startTime * 1000))}</span>`
      : '<b>не встречались</b><span>в просмотренной истории</span>';
  const li = document.createElement('li');
  li.className = `mrow ${ally ? 'ally' : 'enemy'}`;
  li.innerHTML = `
    <div class="who">
      <a class="pname" href="https://www.opendota.com/players/${p.account_id}" target="_blank" rel="noopener">${esc(name)}</a>
      <div class="m-player">${heroHtml(h, { k: p.kills, d: p.deaths, a: p.assists })}</div>
    </div>
    <div class="side">${side}</div>
    <div class="enc">${encHtml}</div>
    ${closed ? '' : `<button type="button" class="m-go" data-pid="${p.account_id}">Все встречи →</button>`}`;
  return li;
}

async function runMatchSearch(mid, myId) {
  currentAbort?.abort();
  const ctrl = new AbortController();
  currentAbort = ctrl;
  const { signal } = ctrl;

  setBusy(true);
  hideError();
  tabState.match = false;
  $('#profiles').hidden = true;
  $('#result').hidden = true;
  $('#match-result').hidden = true;
  $('#crew-result').hidden = true;
  showStatus('Загружаю матч…');

  try {
    const [heroes, m] = await Promise.all([loadHeroes(signal), apiGet(`/matches/${mid}`, signal)]);
    if (!Array.isArray(m.players) || m.players.length === 0) {
      throw new ApiError(404, 'OpenDota ещё не разобрал этот матч — повторите через пару минут.');
    }
    renderMatchHead(m, heroes, myId);
    const mine = m.players.find((p) => p.account_id === myId) ?? null;
    const others = m.players.filter((p) => p.account_id && p.account_id !== myId);
    matchMyId = myId;
    rememberId(myId, mine?.personaname);

    showStatus('Сканирую мою историю матчей…');
    const myMap = new Map();
    await scanHistory(myMap, myId, { max: 2000, maxPages: 4, signal });

    const rows = [];
    for (let i = 0; i < others.length; i++) {
      const p = others[i];
      if (signal.aborted) throw abortError();
      showStatus(`Игрок ${i + 1} из ${others.length}…`);
      $('#status-sub').textContent = p.personaname || `Игрок ${p.account_id}`;
      let closed = false;
      const map = new Map();
      try {
        await scanHistory(map, p.account_id, { max: 2000, maxPages: 4, signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e instanceof ApiError && e.status === 404) closed = true;
        else throw e;
      }
      rows.push({ p, closed, enc: closed ? [] : buildEncounters(myMap, map) });
    }

    rows.sort((a, b) => (a.closed ? 1 : 0) - (b.closed ? 1 : 0) || b.enc.length - a.enc.length);
    const ol = $('#match-players');
    ol.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.appendChild(matchPlayerRow(r.p, r.enc, r.closed, heroes, mine?.player_slot ?? null));
    ol.appendChild(frag);
    tabState.match = true;
    $('#match-result').hidden = false;
    $('#match-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (ctrl === currentAbort) showError('Поиск отменён.');
      return;
    }
    showError(friendlyError(e));
  } finally {
    if (ctrl === currentAbort) {
      setBusy(false);
      currentAbort = null;
    }
  }
}

/* ===== Невидимая тусовка ===== */

const CREW_MODES = {
  '25x500': { candidates: 25, peerPages: 1 },
  '15x2000': { candidates: 15, peerPages: 4 },
  '10x5000': { candidates: 10, peerPages: 10 },
};
const CREW_SOLO_THRESHOLD = 3;
let crewMyId = null;

function crewRow(r, inCrew) {
  const name = r.peer.personaname || `Игрок ${r.peer.account_id}`;
  const av = r.peer.avatarfull
    ? `<img src="${esc(r.peer.avatarfull)}" alt="" loading="lazy" onerror="this.remove()">`
    : esc(name.slice(0, 1).toUpperCase());
  const li = document.createElement('li');
  li.className = `crew-row${inCrew ? '' : ' dimmed'}`;
  li.innerHTML = `
    <div class="avatar">${av}</div>
    <div class="c-info">
      <a href="https://www.opendota.com/players/${r.peer.account_id}" target="_blank" rel="noopener">${esc(name)}</a>
      <span class="muted">всего пересечений: ${r.total} · последняя: ${fmtDate.format(new Date(r.last * 1000))}</span>
    </div>
    <div class="c-stats">
      <b class="${inCrew ? 'c-hot' : ''}">${r.soloTogether} × вместе без пати</b>
      <span class="muted">${r.againstSolo} × друг против друга соло</span>
    </div>
    <button type="button" class="m-go" data-pid="${r.peer.account_id}">Все встречи →</button>`;
  return li;
}

async function runCrewSearch(myId, { candidates: maxCandidates, peerPages, peerWindow }) {
  currentAbort?.abort();
  const ctrl = new AbortController();
  currentAbort = ctrl;
  const { signal } = ctrl;

  setBusy(true);
  hideError();
  tabState.crew = false;
  crewMyId = myId;
  $('#profiles').hidden = true;
  $('#result').hidden = true;
  $('#match-result').hidden = true;
  $('#crew-result').hidden = true;
  showStatus('Сканирую твою историю матчей…');

  try {
    const myMap = new Map();
    const capped = await scanHistory(myMap, myId, {
      max: HARD_CAP,
      maxPages: 20,
      signal,
      onPage: (n) => { $('#status-sub').textContent = `просмотрено ${n} матчей`; },
    });

    showStatus('Ищу частых попутчиков…');
    $('#status-sub').textContent = '';
    const peers = await apiGet(`/players/${myId}/peers`, signal);
    if (!Array.isArray(peers) || peers.length === 0) {
      throw new ApiError(404, 'OpenDota не отслеживает этот аккаунт — попутчиков не найти. Открой профиль на opendota.com, чтобы добавить его.');
    }
    const candidates = [...peers]
      .filter((p) => p.account_id && p.account_id !== myId)
      .sort((x, y) => (y.games ?? 0) - (x.games ?? 0))
      .slice(0, maxCandidates);

    const rows = [];
    let partyFriends = 0;
    for (let i = 0; i < candidates.length; i++) {
      const peer = candidates[i];
      if (signal.aborted) throw abortError();
      showStatus(`Попутчик ${i + 1} из ${candidates.length}…`);
      $('#status-sub').textContent = peer.personaname || `Игрок ${peer.account_id}`;
      const map = new Map();
      try {
        await scanHistory(map, peer.account_id, { max: peerPages * PAGE_SIZE, maxPages: peerPages, signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e instanceof ApiError && e.status === 404) continue;
        throw e;
      }
      const enc = buildEncounters(myMap, map);
      if (!enc.length) continue;
      const soloTogether = enc.filter((x) => x.together && (x.me.party ?? 1) === 1).length;
      const againstSolo = enc.filter((x) => !x.together && (x.me.party ?? 1) === 1).length;
      if (soloTogether === 0 && againstSolo === 0) { partyFriends++; continue; }
      rows.push({ peer, total: enc.length, soloTogether, againstSolo, last: enc[0].startTime });
    }

    rows.sort((a, b) => b.soloTogether - a.soloTogether || b.total - a.total);
    const crew = rows.filter((r) => r.soloTogether >= CREW_SOLO_THRESHOLD);
    const rare = rows.filter((r) => r.soloTogether < CREW_SOLO_THRESHOLD);

    $('#crew-summary').innerHTML = crew.length
      ? `<div>Судьба сводила тебя с <b>${crew.length}</b> ${plural(crew.length, ['игроком', 'игроками', 'игроками'])} минимум ${CREW_SOLO_THRESHOLD} раза — и каждый раз вы оказывались в матче <b>не в пати</b>. Вот они, твоя невидимая тусовка.</div>`
      : `<div>Среди топ-${candidates.length} частых попутчиков случайных повторных встреч без пати не нашлось — либо ты почти всегда в пати, либо тусовка пока не сложилась.</div>`;

    const ol = $('#crew-list');
    ol.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of crew) frag.appendChild(crewRow(r, true));
    for (const r of rare) frag.appendChild(crewRow(r, false));
    ol.appendChild(frag);

    const notes = [
      `Твоя история: ${myMap.size} матчей. У попутчиков учтены последние ~${peerWindow} матчей, так что цифры — нижняя граница. Для точного счёта с конкретным игроком жми «Все встречи».`,
    ];
    if (capped) notes.push('История длиннее 10 000 матчей — учитывалась только самая свежая часть.');
    if (partyFriends) {
      notes.push(`Ещё у ${partyFriends} ${plural(partyFriends, ['попутчика', 'попутчиков', 'попутчиков'])} все пересечения — в пати. Это уже настоящие друзья, их не считаем.`);
    }
    $('#crew-notes').innerHTML = notes.map((n) => `<div>${esc(n)}</div>`).join('');

    tabState.crew = true;
    $('#crew-result').hidden = false;
    $('#crew-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (ctrl === currentAbort) showError('Поиск отменён.');
      return;
    }
    showError(friendlyError(e));
  } finally {
    if (ctrl === currentAbort) {
      setBusy(false);
      currentAbort = null;
    }
  }
}

/* ===== События и запуск ===== */

/* История проверенных ID и выпадающий список с удалением */
function loadIdHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem('d2e-ids') || '[]');
    return Array.isArray(arr) ? arr.filter((x) => x && x.id != null) : [];
  } catch { return []; }
}

function rememberId(id, name) {
  if (id == null) return;
  const list = loadIdHistory();
  const prev = list.find((x) => x.id === id);
  const rest = list.filter((x) => x.id !== id);
  rest.unshift({ id, name: name || prev?.name || null });
  try { localStorage.setItem('d2e-ids', JSON.stringify(rest.slice(0, 8))); } catch { /* ignore */ }
  if (ddInput) renderDropdown();
}

function forgetId(id) {
  const rest = loadIdHistory().filter((x) => String(x.id) !== String(id));
  try { localStorage.setItem('d2e-ids', JSON.stringify(rest)); } catch { /* ignore */ }
}

const idDd = document.createElement('div');
idDd.id = 'id-dropdown';
idDd.hidden = true;
document.body.appendChild(idDd);
let ddInput = null;

function renderDropdown() {
  const list = loadIdHistory();
  if (!list.length) { closeDropdown(); return; }
  idDd.innerHTML = list.map((x) => `
    <div class="id-opt" data-id="${x.id}">
      <span class="id-opt-label">${x.id}${x.name ? ` — ${esc(x.name)}` : ''}</span>
      <button type="button" class="id-del" data-del="${x.id}" title="Убрать из списка">✕</button>
    </div>`).join('');
}

function openDropdown(input) {
  if (!loadIdHistory().length) return;
  ddInput = input;
  renderDropdown();
  const r = input.getBoundingClientRect();
  idDd.style.left = `${r.left + window.scrollX}px`;
  idDd.style.top = `${r.bottom + window.scrollY + 4}px`;
  idDd.style.width = `${r.width}px`;
  idDd.hidden = false;
}

function closeDropdown() {
  idDd.hidden = true;
  ddInput = null;
}

['input-a', 'input-ma', 'input-ca'].forEach((name) => {
  const el = document.getElementById(name);
  el.addEventListener('focus', () => openDropdown(el));
  el.addEventListener('click', () => openDropdown(el));
});

document.addEventListener('mousedown', (e) => {
  if (!idDd.hidden && !idDd.contains(e.target) && e.target !== ddInput) closeDropdown();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDropdown();
});

idDd.addEventListener('mousedown', (e) => {
  const del = e.target.closest('.id-del');
  if (del) {
    e.stopPropagation();
    forgetId(del.dataset.del);
    renderDropdown();
    return;
  }
  const opt = e.target.closest('.id-opt');
  if (opt && ddInput) {
    ddInput.value = opt.dataset.id;
    closeDropdown();
    ddInput.focus();
  }
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  handlePlayersSubmit();
});

function handlePlayersSubmit() {
  hideError();

  const a = parseAccountId($('#input-a').value);
  const b = parseAccountId($('#input-b').value);
  if (a == null) return showError('Не удалось распознать ваш ID. Введите ID Dota 2 (число), SteamID64, SteamID3 или ссылку на профиль.');
  if (b == null) return showError('Не удалось распознать ID второго игрока — тот же формат, что и у первого.');
  if (a === b) return showError('ID должны быть разными — сравнить игрока можно только с другим игроком.');

  rememberId(a);

  const depthRaw = $('#depth').value;
  const depth = depthRaw === 'all' ? null : Number(depthRaw);
  const insignif = $('#include-insignificant').checked;

  try {
    const q = new URLSearchParams({ a: String(a), b: String(b) });
    if (depthRaw !== 'all') q.set('d', depthRaw);
    history.replaceState(null, '', `?${q}`);
  } catch { /* file:// и т.п. */ }

  runSearch(a, b, { depth, insignif });
}

document.querySelectorAll('.cancel-btn').forEach((b) => b.addEventListener('click', () => currentAbort?.abort()));
/* У каждой вкладки свой последний результат; переключение просто показывает нужный */
const tabState = { players: false, match: false, crew: false };

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#search-form').hidden = name !== 'players';
  $('#match-form').hidden = name !== 'match';
  $('#crew-form').hidden = name !== 'crew';
  const playersOn = name === 'players';
  $('#profiles').hidden = !playersOn || !tabState.players;
  $('#result').hidden = !playersOn || !tabState.players;
  $('#match-result').hidden = playersOn || name !== 'match' || !tabState.match;
  $('#crew-result').hidden = name !== 'crew' || !tabState.crew;
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$('#match-form').addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();

  const mid = parseMatchId($('#input-mid').value);
  const a = parseAccountId($('#input-ma').value);
  if (mid == null) return showError('Не удалось распознать ID матча — введите число или ссылку вида opendota.com/matches/1234567890.');
  if (a == null) return showError('Не удалось распознать ваш ID. Введите ID Dota 2 (число), SteamID64, SteamID3 или ссылку на профиль.');

  rememberId(a);

  try {
    history.replaceState(null, '', `?a=${a}&mid=${mid}`);
  } catch { /* file:// и т.п. */ }

  runMatchSearch(mid, a);
});

$('#match-players').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pid]');
  if (!btn || matchMyId == null) return;
  $('#input-a').value = String(matchMyId);
  $('#input-b').value = btn.dataset.pid;
  // разбор матча остаётся в своей вкладке — можно вернуться и выбрать другого игрока
  switchTab('players');
  handlePlayersSubmit();
});

$('#crew-form').addEventListener('submit', (e) => {
  e.preventDefault();
  hideError();

  const a = parseAccountId($('#input-ca').value);
  if (a == null) return showError('Не удалось распознать ваш ID. Введите ID Dota 2 (число), SteamID64, SteamID3 или ссылку на профиль.');

  rememberId(a);

  const mode = CREW_MODES[$('#crew-depth').value] ?? CREW_MODES['25x500'];

  try { history.replaceState(null, '', `?c=${a}`); } catch { /* file:// и т.п. */ }

  runCrewSearch(a, { candidates: mode.candidates, peerPages: mode.peerPages, peerWindow: mode.peerPages * PAGE_SIZE });
});

$('#crew-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pid]');
  if (!btn || crewMyId == null) return;
  $('#input-a').value = String(crewMyId);
  $('#input-b').value = btn.dataset.pid;
  switchTab('players');
  handlePlayersSubmit();
});

$('#more-btn').addEventListener('click', appendChunk);
$('#input-a').addEventListener('input', hideError);
$('#input-b').addEventListener('input', hideError);

(function init() {
  const q = new URLSearchParams(location.search);
  const a = q.get('a');
  const b = q.get('b');
  const d = q.get('d');
  const mid = q.get('mid');
  const c = q.get('c');
  if (d === '500' || d === '2000') $('#depth').value = d;
  // поля остаются пустыми — ранее проверенные ID доступны в выпадающем списке
  if (a) $('#input-a').value = a;
  if (b) $('#input-b').value = b;
  if (mid) {
    switchTab('match');
    if (a) $('#input-ma').value = a;
    $('#input-mid').value = mid;
    const myId = parseAccountId(a);
    if (myId != null && parseMatchId(mid) != null) runMatchSearch(parseMatchId(mid), myId);
    return;
  }
  if (c) {
    switchTab('crew');
    $('#input-ca').value = c;
    const myId = parseAccountId(c);
    if (myId != null) {
      const mode = CREW_MODES[$('#crew-depth').value] ?? CREW_MODES['25x500'];
      runCrewSearch(myId, { candidates: mode.candidates, peerPages: mode.peerPages, peerWindow: mode.peerPages * PAGE_SIZE });
    }
    return;
  }
  if (parseAccountId(a) != null && parseAccountId(b) != null && parseAccountId(a) !== parseAccountId(b)) {
    $('#search-form').requestSubmit();
  }
})();
