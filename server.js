import express from 'express';
import nunjucks from 'nunjucks';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.APPLET_ID ? 3000 : (process.env.PORT || 3000);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static directories
app.use('/static', express.static(path.join(__dirname, 'templates/static'), {
  maxAge: '1d'
}));
app.use('/photo', express.static(path.join(__dirname, 'photo'), {
  maxAge: '1d'
}));

// Setup Nunjucks
const env = nunjucks.configure(path.join(__dirname, 'templates'), {
  autoescape: true,
  express: app,
  noCache: true
});
env.addGlobal('static_ver', '1');

// Auth configuration
const AUTH_COOKIE_NAME = 'choco_auth';
const AUTH_COOKIE_VALUE = 'choco_session_ok';
const WELCOME_COOKIE_NAME = 'choco_welcome_seen';
const HARDCODED_PASSWORD = 'choco';
const CURRENT_VERSION = '1.48';

const PUBLIC_EXACT = new Set([
  '/login',
  '/api/login',
  '/forgot',
  '/api/quiz-login',
  '/whats',
  '/version'
]);

const PUBLIC_PREFIXES = ['/static/', '/photo/', '/proxy/', '/thumb/'];

// Auth middleware
app.use((req, res, next) => {
  const p = req.path;
  if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some(prefix => p.startsWith(prefix))) {
    return next();
  }
  const token = req.cookies[AUTH_COOKIE_NAME];
  if (token !== AUTH_COOKIE_VALUE) {
    return res.redirect('/login');
  }
  next();
});

// Proxy and Instance Cache
const INVIDIOUS_LIST_URL = 'https://raw.githubusercontent.com/kuru-bana/yt-data/refs/heads/main/list/injidious.json';
const FALLBACK_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.private.coffee',
  'https://yt.artemislena.eu',
  'https://invidious.projectsegfau.lt'
];

let cachedInstances = null;
let lastInstanceFetch = 0;
const INSTANCE_CACHE_TTL = 5 * 60 * 1000;

async function getInvidiousInstances() {
  const now = Date.now();
  if (cachedInstances && (now - lastInstanceFetch < INSTANCE_CACHE_TTL)) {
    return cachedInstances;
  }
  try {
    const r = await fetch(INVIDIOUS_LIST_URL, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list) && list.length > 0) {
        cachedInstances = list;
        lastInstanceFetch = now;
        return cachedInstances;
      }
    }
  } catch (e) {
    // fallback
  }
  if (!cachedInstances) {
    cachedInstances = FALLBACK_INSTANCES;
    lastInstanceFetch = now;
  }
  return cachedInstances;
}

function mapPath(appPath) {
  const trendingMatch = appPath.match(/^\/api\/trending\/(music|gaming|news|movies)([?].*)?$/i);
  if (trendingMatch) {
    const typeName = trendingMatch[1].toLowerCase();
    const qsPart = trendingMatch[2] || '';
    const typeMap = { music: 'Music', gaming: 'Gaming', news: 'News', movies: 'Movies' };
    const invidiousPath = qsPart
      ? `/api/v1/trending${qsPart}&type=${typeMap[typeName]}`
      : `/api/v1/trending?type=${typeMap[typeName]}`;
    return { category: `trending_${typeName}`, invidiousPath };
  }

  const streamMatch = appPath.match(/^\/api\/stream\/([^?]+)(.*)/);
  if (streamMatch) {
    return { category: 'video', invidiousPath: `/api/v1/videos/${streamMatch[1]}${streamMatch[2]}` };
  }

  if (appPath.startsWith('/api/search/suggestions')) {
    return { category: 'search_suggestions', invidiousPath: '/api/v1/search/suggestions' + appPath.slice('/api/search/suggestions'.length) };
  }

  const channelMatch = appPath.match(/^\/api\/channels\/([^/?]+)\/(videos|shorts|streams|latest|playlists|comments|search)(.*)/);
  if (channelMatch) {
    return { category: `channel_${channelMatch[2]}`, invidiousPath: `/api/v1/channels/${channelMatch[1]}/${channelMatch[2]}${channelMatch[3]}` };
  }

  const prefixes = [
    ['/api/trending', 'trending'],
    ['/api/search', 'search'],
    ['/api/channels', 'channel'],
    ['/api/videos', 'video'],
    ['/api/playlists', 'playlist'],
    ['/api/mixes', 'mix'],
    ['/api/hashtag', 'hashtag'],
    ['/api/comments', 'comments'],
    ['/api/transcripts', 'transcripts'],
    ['/api/captions', 'captions'],
    ['/api/annotations', 'annotations'],
    ['/api/clip', 'clip'],
    ['/api/resolveurl', 'resolveurl'],
    ['/api/popular', 'popular'],
    ['/api/stats', 'stats'],
  ];

  for (const [prefix, category] of prefixes) {
    if (appPath.startsWith(prefix)) {
      return { category, invidiousPath: '/api/v1' + appPath.slice(4) };
    }
  }

  return { category: 'video', invidiousPath: '/api/v1' + appPath.slice(4) };
}

async function proxyParallel(invidiousPath, excludeList = []) {
  const instances = await getInvidiousInstances();
  const validInstances = instances.filter(i => !excludeList.some(ex => i.includes(ex)));
  const candidates = validInstances.length ? validInstances : FALLBACK_INSTANCES;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 16000);

  const promises = candidates.slice(0, 5).map(async (base) => {
    const url = base.replace(/\/$/, '') + invidiousPath;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    if (data && !data.error) {
      return { data, usedInstance: base };
    }
    throw new Error('Invalid response');
  });

  try {
    const result = await Promise.any(promises);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error('All upstream instances failed');
  }
}

// ── Game list ──────────────────────────────────────────────────────────
const GAMES = [
  { slug: "2048", title: "2048", thumb: "/photo/game/2048.webp", desc: "スライドしてタイルを合体！2048を目指す数字パズル。", file: "templates/tool/game/fun/2048.html", genre: "パズル" },
  { slug: "backroom", title: "Backrooms", thumb: "/photo/game/backroom.png", desc: "バックルームの不気味な迷宮を探索するホラーサバイバルゲーム。", file: "templates/tool/game/fun/backroom.html", genre: "ホラー" },
  { slug: "battle_star", title: "Battle Star", thumb: "/photo/game/battle_star.png", desc: "星をめぐる宇宙バトルアクション。", file: "templates/tool/game/fun/battle_star.html", genre: "アクション" },
  { slug: "block-blast", title: "Block Blast", thumb: "/photo/game/block-blast.jpg", desc: "ブロックを配置してラインを消す爽快パズルゲーム。", file: "templates/tool/game/fun/block-blast.html", genre: "パズル" },
  { slug: "Count_Master", title: "Count Masters", thumb: "/photo/game/Count_Masters.png", desc: "仲間を増やしながら走り、敵を数の力で圧倒するカジュアルバトル。", file: "templates/tool/game/fun/Count_Master.html", genre: "カジュアル" },
  { slug: "dyping", title: "DyPing", thumb: "/photo/game/dyping.gif", desc: "世にも奇妙なtyping~ダイピング~", file: "templates/tool/game/fun/dyping.html", genre: "タイピング" },
  { slug: "hole-io", title: "Hole.io", thumb: "/photo/game/hole.io.webp", desc: "穴を大きくしながら街を丸ごと飲み込む .io ゲーム。", file: "templates/tool/game/fun/hole-io.html", genre: "カジュアル" },
  { slug: "needy-streamer-overload", title: "Needy Streamer Overload", thumb: "/photo/game/needy-streamer-overload.jpg", desc: "ストレス限界の配信者を支える異色のシミュレーション。", file: "templates/tool/game/fun/needy-streamer-overload.html", genre: "シミュレーション" },
  { slug: "repo", title: "Repo", thumb: "/photo/game/repo.png", desc: "リポから物資を回収して帰還するサバイバルシミュレーション。", file: "templates/tool/game/fun/repo.html", genre: "シミュレーション" },
  { slug: "run-1", title: "Run 1", thumb: "/photo/game/run-1.webp", desc: "宇宙トンネルをひたすら走り続けるエンドレスアクション。", file: "templates/tool/game/fun/run-1.html", genre: "アクション" },
  { slug: "run-3", title: "Run 3", thumb: "/photo/game/run3.webp", desc: "宇宙の果てまで続くトンネルを疾走する人気ランナー第3弾。", file: "templates/tool/game/fun/run-3.html", genre: "アクション" },
  { slug: "run-3-freezenova", title: "Run 3 (Freezenova)", thumb: "/photo/game/run-3freezenova.webp", desc: "Freezenova版のRun 3。宇宙トンネルを3Dで駆け抜けろ。", file: "templates/tool/game/fun/run-3-freezenova.html", genre: "アクション" },
  { slug: "snow-rider", title: "Snow Rider", thumb: "/photo/game/snow-rider.webp", desc: "雪山をそりで滑り降りる爽快スノーレースゲーム。", file: "templates/tool/game/fun/snow-rider.html", genre: "アクション" },
  { slug: "snow-rider-3d", title: "Snow Rider 3D", thumb: "/photo/game/snow-rider-3d.webp", desc: "3Dグラフィックで楽しむスノーライダー。", file: "templates/tool/game/fun/snow-rider-3d.html", genre: "アクション" },
  { slug: "steal-a-brainrot", title: "Steal a Brainrot", thumb: "/photo/game/steal-a-brainrot.jpg", desc: "ブレインロットキャラを盗み合う戦略カジュアルゲーム。", file: "templates/tool/game/fun/steal-a-brainrot.html", genre: "カジュアル" },
  { slug: "steal-brainrot-duel", title: "Steal Brainrot Duel", thumb: "/photo/game/steal-brainrot-duel.webp", desc: "1対1のブレインロット対決。", file: "templates/tool/game/fun/steal-brainrot-duel.html", genre: "カジュアル" },
  { slug: "steal-brainrot-heist", title: "Steal Brainrot Heist", thumb: "/photo/game/steal-brainrot-heist.webp", desc: "チームで挑むブレインロット強奪作戦。", file: "templates/tool/game/fun/steal-brainrot-heist.html", genre: "カジュアル" },
  { slug: "super-mario-64", title: "Super Mario 64", thumb: "/photo/game/super-mario-64.webp", desc: "伝説の3Dアクション、ブラウザで遊べるマリオ64。", file: "templates/tool/game/fun/super-mario-64.html", genre: "アクション" },
  { slug: "tomodachi-collection", title: "Tomodachi Collection", thumb: "/photo/game/tomodachi-collection.webp", desc: "島でともだちと暮らすほのぼのライフシミュレーション。", file: "templates/tool/game/fun/tomodachi-collection.html", genre: "シミュレーション" },
  { slug: "cobb-can-move", title: "Cobb Can Move", thumb: "/photo/game/cobb-can-move.png", desc: "敵だけがレベルアップし続けるホラーゲーム。", file: "templates/tool/game/fun/cobb-can-move.html", genre: "ホラー" },
  { slug: "choco-quiz", title: "チョコクイズ", thumb: "/photo/game/choco-quiz.svg", desc: "チョコレートの知識を試す本格クイズ！", file: "templates/tool/game/fun/choco-quiz.html", genre: "クイズ" }
];

const GAME_MAP = Object.fromEntries(GAMES.map(g => [g.slug, g]));

// ── Proxy services list ────────────────────────────────────────────────
const PROXY_SERVICES = {
  "daydreamx": { name: "DayDreamX", image: "/photo/proxy/daydreamx.png", gh: "daydreamx", desc: "学校や職場のネットワーク制限を回避できるアンブロックサイト集。" },
  "dogeweb": { name: "DogeWeb", image: "/photo/proxy/degeweb.png", gh: "dogeweb", desc: "シンプルなUIが特徴のアンブロックプロキシサービス。" },
  "galaxy": { name: "Galaxy", image: "/photo/proxy/galaxy.png", gh: "galaxy", desc: "宇宙をテーマにしたデザインのプロキシサイト。" },
  "interstellar": { name: "Interstellar", image: "/photo/proxy/Interstellar.jpg", gh: "interstellar", desc: "定番の人気アンブロックサービス。" },
  "lunar": { name: "Lunar", image: "/photo/proxy/lunar.png", gh: "lunar", desc: "月をモチーフにしたシンプルなプロキシサービス。" },
  "petezah": { name: "Petezah", image: "/photo/proxy/petezah.png", gh: "petezah", desc: "有名なアンブロックゲームサイトのひとつ。" },
  "rammer": { name: "Rammer", image: "/photo/proxy/rammer.png", gh: "rammer", desc: "軽量で読み込みが速いプロキシサービス。" },
  "revault": { name: "Re:vault", image: "/photo/proxy/re:vault.png", gh: "revault", desc: "デザイン性の高いアンブロックサイト。" },
  "shadow": { name: "Shadow", image: "/photo/proxy/shadow.png", gh: "shadow", desc: "ダークテーマが特徴のプロキシサービス。" },
  "solocentral": { name: "SoloCentral", image: "/photo/proxy/solocentral.png", gh: "solocentral", desc: "ゲームサイトに特化したアンブロックプロキシ。" },
  "space": { name: "Space", image: "/photo/proxy/space.png", gh: "space", desc: "宇宙をテーマにしたアンブロックサイト。" },
  "utopia": { name: "Utopia", image: "/photo/proxy/utopia.png", gh: "utopia", desc: "使いやすさに定評のあるプロキシサービス。" }
};

const GH_BASE = "https://raw.githubusercontent.com/kuru-bana/Link-list/main/proxy/";

// ── Auth & Session Routes ──────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.render('login.html');
});

app.get('/forgot', (req, res) => {
  res.render('forgot.html');
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  const trimmed = (password || '').trim();
  if (trimmed && trimmed !== HARDCODED_PASSWORD) {
    return res.status(401).json({ ok: false, message: 'パスワードが正しくありません' });
  }
  const seenWelcome = req.cookies[WELCOME_COOKIE_NAME];
  const redirect = seenWelcome ? '/' : '/about';
  res.cookie(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  return res.json({ ok: true, redirect });
});

app.post('/api/quiz-login', (req, res) => {
  const { score = 0 } = req.body || {};
  if (score < 3) {
    return res.status(401).json({ ok: false, message: '正解数が足りません' });
  }
  const seenWelcome = req.cookies[WELCOME_COOKIE_NAME];
  const redirect = seenWelcome ? '/' : '/about';
  res.cookie(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  return res.json({ ok: true, redirect });
});

app.get('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME);
  res.redirect('/login');
});

// ── Main Page Routes ───────────────────────────────────────────────────
app.get('/', async (req, res) => {
  res.render('index.html', { active: 'home', access_count: 0 });
});

app.get('/trending', (req, res) => {
  res.render('trending.html', { active: 'trending' });
});

app.get('/dl', (req, res) => {
  res.render('dl.html', { active: 'dl' });
});

app.get('/watch', (req, res) => {
  res.render('watch.html');
});

app.get('/shorts/:videoId', (req, res) => {
  res.render('shorts.html', { edu_params_json: '[]' });
});

app.get('/search', (req, res) => {
  res.render('search.html');
});

app.get('/channel', (req, res) => {
  res.render('channel.html');
});

app.get('/playlist', (req, res) => {
  res.render('playlist.html');
});

app.get('/hashtag', (req, res) => {
  res.render('hashtag.html');
});

app.get('/mix', (req, res) => {
  res.render('mix.html');
});

app.get('/library', (req, res) => {
  res.render('library.html', { active: 'library' });
});

app.get('/settings', (req, res) => {
  res.render('settings.html', { active: 'settings' });
});

app.get('/links', (req, res) => {
  res.render('links.html', { active: 'links' });
});

app.get('/about', (req, res) => {
  const isFirstVisit = !req.cookies[WELCOME_COOKIE_NAME];
  res.cookie(WELCOME_COOKIE_NAME, '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });
  res.render('about.html', {
    active: 'about',
    current_version: CURRENT_VERSION,
    is_first_visit: isFirstVisit
  });
});

app.get('/contact', (req, res) => {
  res.render('contact.html', { active: 'contact' });
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/chat-page.html'));
});

app.get('/chat-raw', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/chat-test.html'));
});

// ── Tool Routes ────────────────────────────────────────────────────────
app.get('/tool', (req, res) => {
  res.render('tool/home.html', { active: 'tool' });
});

app.get('/tool/youtube', (req, res) => {
  res.render('tool/youtube/index.html', { active: 'tool' });
});

app.get('/tool/youtube/sia', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/youtube/sia-tube.html'));
});

app.get('/tool/youtube/xerox', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/youtube/xerox.html'));
});

app.get('/tool/youtube/light', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/youtube/light.html'));
});

app.get('/tool/youtube/nakayosi', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/youtube/nakayosi.html'));
});

app.get('/tool/youtube/uowtube', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/youtube/uowtube.html'));
});

app.get('/tool/youtube/ikura', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/youtube/ikura.html'));
});

let wistaHtmlCache = null;
function serveWista(req, res) {
  if (!wistaHtmlCache) {
    const raw = fs.readFileSync(path.join(__dirname, 'templates/tool/youtube/wista.html'), 'utf-8');
    const autoHome = '<script>(function(){var p=window.location.pathname;var B="/tool/youtube/wista";if((p===B||p===B+"/")&&localStorage.getItem("tube_auth")){history.replaceState(null,"",B+"/home");}})();</script>';
    wistaHtmlCache = raw
      .replace('basename:t="/"', 'basename:t="/tool/youtube/wista"')
      .replace('<head>', '<head>' + autoHome);
  }
  res.send(wistaHtmlCache);
}
app.use('/tool/youtube/wista', serveWista);

// Games
app.get('/tool/game', (req, res) => {
  res.render('tool/game/landing.html', { active: 'tool' });
});

app.get('/tool/game/fun', (req, res) => {
  res.render('tool/game/home.html', { games: GAMES, active: 'tool' });
});

app.get('/tool/game/cloudmoon', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates/tool/game/cloudmoon/index.html'));
});

app.get('/tool/game/raw/:slug', (req, res) => {
  const game = GAME_MAP[req.params.slug];
  if (!game || !fs.existsSync(path.join(__dirname, game.file))) {
    return res.status(404).send('Game not found');
  }
  res.sendFile(path.join(__dirname, game.file));
});

app.get('/tool/game/:slug', (req, res) => {
  const game = GAME_MAP[req.params.slug];
  if (!game) return res.redirect('/tool/game');
  res.render('tool/game/play.html', { game, active: 'tool' });
});

// Programming
app.get('/tool/programing', (req, res) => {
  res.render('tool/programing/home.html', { active: 'tool' });
});

app.get('/tool/programing/:page', (req, res) => {
  const p = req.params.page;
  const filePath = path.join(__dirname, `templates/tool/programing/${p}.html`);
  if (fs.existsSync(filePath)) {
    res.render(`tool/programing/${p}.html`, { active: 'tool' });
  } else {
    res.redirect('/tool/programing');
  }
});

// Proxy
app.get('/tool/proxy', (req, res) => {
  res.render('tool/proxy/home.html', { services: PROXY_SERVICES, active: 'tool' });
});

app.get('/tool/proxy/:slug', (req, res) => {
  const slug = req.params.slug;
  const service = PROXY_SERVICES[slug];
  if (!service) return res.redirect('/tool/proxy');
  const ghUrl = GH_BASE + service.gh + ".json";
  res.render('tool/proxy/detail.html', { slug, service, gh_url: ghUrl, active: 'tool' });
});

app.get('/tool/proxy/:slug/embed', (req, res) => {
  const slug = req.params.slug;
  const service = PROXY_SERVICES[slug];
  if (!service) return res.redirect('/tool/proxy');
  const ghUrl = GH_BASE + service.gh + ".json";
  res.render('tool/proxy/embed.html', { slug, service, gh_url: ghUrl, initial_url: req.query.u || '', active: 'tool' });
});

// ── API & Proxy Endpoints ──────────────────────────────────────────────
app.get('/whats', (req, res) => {
  res.json({ name: "choco-tube-plus" });
});

app.get('/version', (req, res) => {
  res.json({ ver: CURRENT_VERSION });
});

app.get('/api/tos', async (req, res) => {
  try {
    const r = await fetch('https://raw.githubusercontent.com/kuru-bana/choco-chat-tool/refs/heads/main/tos.json');
    if (r.ok) {
      const data = await r.json();
      return res.json(data);
    }
  } catch (e) {}
  res.json({ error: "Unavailable" });
});

app.get('/choco-chat-new', async (req, res) => {
  try {
    const r = await fetch('https://raw.githubusercontent.com/kuru-bana/choco-chat-tool/refs/heads/main/url.json');
    if (r.ok) {
      const data = await r.json();
      return res.json(data);
    }
  } catch (e) {}
  res.json({ error: "Unavailable" });
});

// Thumbnail Proxy
const THUMB_ALLOWED = new Set([
  'i.ytimg.com', 'i9.ytimg.com', 'yt3.ggpht.com',
  'yt3.googleusercontent.com', 'lh3.googleusercontent.com'
]);

app.get('/api/thumb', async (req, res) => {
  const targetUrl = req.query.url;
  const w = req.query.w;
  const fmt = req.query.fmt;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const parsed = new URL(targetUrl);
    if (!THUMB_ALLOWED.has(parsed.hostname)) {
      return res.status(403).json({ error: 'disallowed host' });
    }
    let fetchUrl = targetUrl;
    if (w) {
      fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + `w=${w}`;
    }
    const r = await fetch(fetchUrl, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}` });

    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const arrayBuffer = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (fmt === 'b64') {
      const b64 = buffer.toString('base64');
      return res.json({ src: `data:${ct};base64,${b64}` });
    }

    res.set({
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    res.send(buffer);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// Suggestions
app.get('/api/search/suggestions', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ suggestions: [] });
  try {
    const r = await fetch(`https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const text = await r.text();
      const match = text.match(/window\.google\.ac\.h\((.*)\)/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        const suggestions = (parsed[1] || []).map(item => item[0]);
        return res.json({ suggestions });
      }
    }
  } catch (e) {}
  res.json({ suggestions: [] });
});

// Piped suggestions & search
app.get('/api/piped-suggestions', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ suggestions: [] });
  try {
    const r = await fetch(`https://pipedapi.kavin.rocks/suggestions?query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const data = await r.json();
      return res.json({ suggestions: Array.isArray(data) ? data : [] });
    }
  } catch (e) {}
  res.json({ suggestions: [] });
});

// Main & Stream Invidious Proxy
app.use('/proxy/main', async (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  const qs = new URL(req.originalUrl || req.url, `http://${host}`).search;
  const appPath = (req.path.startsWith('/') ? req.path : '/' + req.path) + qs;
  const { invidiousPath } = mapPath(appPath);

  try {
    const result = await proxyParallel(invidiousPath);
    return res.json(result.data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.use('/proxy/stream', async (req, res) => {
  const host = req.headers.host || 'localhost:3000';
  const query = { ...req.query };
  const excludeList = (query.exclude || '').split(',').map(s => s.trim()).filter(Boolean);
  delete query.exclude;
  const qs = new URLSearchParams(query).toString();
  const appPath = (req.path.startsWith('/') ? req.path : '/' + req.path) + (qs ? '?' + qs : '');
  const { invidiousPath } = mapPath(appPath);

  try {
    const result = await proxyParallel(invidiousPath, excludeList);
    if (result.usedInstance) {
      res.set('X-Instance-Used', result.usedInstance);
    }
    return res.json(result.data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// Download stream
app.get('/download', async (req, res) => {
  const downloadUrl = req.query.url;
  const filename = req.query.filename || 'download';
  if (!downloadUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const upstream = await fetch(downloadUrl);
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);

    res.set({
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream'
    });

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// Wista SPA fallback
app.use((req, res) => {
  const p = req.path;
  if (p.startsWith('/__replco') || p.startsWith('/@') || p.startsWith('/node_modules') ||
      p.endsWith('.js') || p.endsWith('.ts') || p.endsWith('.map')) {
    return res.status(404).send('Not found');
  }
  serveWista(req, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Choco-Tube-Plus running on port ${PORT}`);
});
