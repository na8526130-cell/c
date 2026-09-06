;// ── Watch page global state (shared across watch-*.js modules) ──
let hqActive = false;
let hqSyncRemovers = [];
let lastStreamSrc = '';
// ── iframe 再生位置トラッキング ──
// YouTube IFrame API の postMessage で実際の currentTime を取得する
let _iframeCurrentTime = 0;   // IFrame API から取得した実際の再生位置
let _iframeStartSec    = 0;   // iframe 起動時の開始秒（フォールバック用）
let _iframeStartWall   = 0;   // iframe 起動時のタイムスタンプ（フォールバック用）
let _iframeEl          = null; // 現在アクティブな iframe 要素
let _iframePolling     = null; // setInterval の ID
let _iframeDuration    = 0;   // iframe 動画の尺（onStateChange duration補完用）
let _iframePlayerState = -1;  // -1=未知, 1=再生中, 2=一時停止, 0=終了
let _iframeVolume      = 100; // iframe 音量 (0-100)
let _iframeMuted       = false; // iframe ミュート状態
let _iframeRate        = 1;   // iframe 再生速度
let _clipStartSec      = -1;  // 再生区間: 開始秒 (-1 = 未設定)
let _clipEndSec        = -1;  // 再生区間: 終了秒 (-1 = 未設定)

let volState = (() => {
  const s = getSettings();
  const vol = Math.max(0, Math.min(1, (s.defaultVolume ?? 100) / 100));
  return { vol, muted: false };
})();
let currentStreamData = null;
let currentVideoMeta = null;
let currentVideoId = '';
let _relatedVideos = [];
let streamOnlyMode = 'normal'; // 'normal' | 'audio' | 'video'
let streamBestAudioUrl = '';
let streamAudioFormats = [];
let streamVideoFormats = [];
let lastNormalStreamSrc = '';
let cachedInvInstance = null;
let playerErrorHandler = null;
let streamSourcePref = getSettings().streamSource || 'auto'; // 'auto' | 'invidious' | 'rapidapi'

// ── Transcript state ──
let transcriptTracks = [];
let currentLang = null;
let activeTranscriptLine = null;

// ── URL params ──
const params = new URLSearchParams(location.search);
const videoId = params.get('v');
const listParam = params.get('list');
const indexParam = parseInt(params.get('index') || '-1', 10);

// ── Entry point ──
document.addEventListener('DOMContentLoaded', () => {
  if (!document.body.classList.contains('page-watch')) return;
  initHeaderSearch();
  if (!videoId) {
    showWatchError('動画IDが指定されていません。', true);
  } else {
    initWatch(videoId);
  }
});

// ── Utilities (also used by watch-*.js modules) ──
function getSavedPosition(videoId) {
  try {
    const raw = localStorage.getItem('chocotube_positions');
    if (!raw) return 0;
    const positions = JSON.parse(raw);
    const entry = positions[videoId];
    if (!entry) return 0;
    if (Date.now() - entry.ts > 30 * 24 * 60 * 60 * 1000) return 0;
    return entry.t || 0;
  } catch { return 0; }
}
function savePosition(videoId, time) {
  try {
    const raw = localStorage.getItem('chocotube_positions');
    const positions = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    Object.keys(positions).forEach(k => {
      if (now - (positions[k].ts || 0) > 30 * 24 * 60 * 60 * 1000) delete positions[k];
    });
    if (time > 5) {
      positions[videoId] = { t: Math.floor(time), ts: now };
    } else {
      delete positions[videoId];
    }
    localStorage.setItem('chocotube_positions', JSON.stringify(positions));
  } catch {}
}
function clearSavedPosition(videoId) {
  try {
    const raw = localStorage.getItem('chocotube_positions');
    if (!raw) return;
    const positions = JSON.parse(raw);
    delete positions[videoId];
    localStorage.setItem('chocotube_positions', JSON.stringify(positions));
  } catch {}
}

function showWatchError(msg, isHome) {
  const main = document.getElementById('watchMain');
  main.innerHTML = `
    <div class="watch-error">
      <div class="watch-error-icon">⚠️</div>
      <h2>${escapeHtml(msg)}</h2>
      ${isHome ? '<p><a href="/">トップページへ戻る</a></p>' : ''}
    </div>
  `;
}

function createRelatedSkeleton() {
  const div = document.createElement('div');
  div.className = 'related-skeleton';
  div.innerHTML = `
    <div class="related-sk-thumb"></div>
    <div class="related-sk-info">
      <div class="related-sk-line rsk-t1"></div>
      <div class="related-sk-line rsk-t2"></div>
      <div class="related-sk-line rsk-ch"></div>
      <div class="related-sk-line rsk-vw"></div>
    </div>
  `;
  return div;
}

function createRelatedCard(video) {
  const a = document.createElement('a');
  a.className = 'related-card';
  a.href = `/watch?v=${video.videoId}`;
  const thumb = getThumbnailUrl(video.videoId);
  const dur = formatDuration(video.lengthSeconds);
  const views = formatViews(video.viewCount);
  const channelHref = video.authorId ? `/channel?id=${encodeURIComponent(video.authorId)}` : null;

  a.innerHTML = `
    <div class="related-thumb-wrap">
      <img class="related-thumb" src="${thumb}" alt="${escapeHtml(video.title)}" loading="lazy" onload="this.classList.add('loaded')" />
      ${dur ? `<span class="related-duration">${dur}</span>` : ''}
    </div>
    <div class="related-info">
      <div class="related-title-text">${escapeHtml(video.title)}</div>
      <div class="related-channel-row">
        ${channelHref
          ? `<a class="related-ch-channel-link" href="${channelHref}">
               <div class="related-ch-icon-wrap"><div class="related-ch-placeholder"></div></div>
               <span class="related-channel">${escapeHtml(video.author || '')}</span>
             </a>`
          : `<div class="related-ch-icon-wrap"><div class="related-ch-placeholder"></div></div>
             <span class="related-channel">${escapeHtml(video.author || '')}</span>`
        }
      </div>
      ${views ? `<div class="related-views">${views}</div>` : ''}
    </div>
  `;

  if (channelHref) {
    const chLink = a.querySelector('.related-ch-channel-link');
    chLink.addEventListener('click', e => e.stopPropagation());
  }

  return a;
}

function lazyLoadRelatedIcons(videos, cards) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const wrap = entry.target;
      const authorId = wrap.dataset.authorId;
      if (!authorId) return;
      observer.unobserve(wrap);
      delete wrap.dataset.authorId;

      fetchChannelAvatar(authorId).then(thumbs => {
        if (!thumbs || !wrap.isConnected) return;
        const iconUrl = getChannelIconUrl(thumbs);
        if (!iconUrl) return;
        const placeholder = wrap.querySelector('.related-ch-placeholder');
        if (!placeholder) return;
        const img = document.createElement('img');
        img.className = 'related-ch-icon';
        img.src = iconUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.onload = () => img.classList.add('loaded');
        placeholder.replaceWith(img);
      });
    });
  }, { rootMargin: '120px' });

  cards.forEach((card, i) => {
    const video = videos[i];
    if (!video || !video.authorId) return;
    const wrap = card.querySelector('.related-ch-icon-wrap');
    if (!wrap) return;
    wrap.dataset.authorId = video.authorId;
    observer.observe(wrap);
  });
}

function renderRelated(videos) {
  const list = document.getElementById('relatedList');
  list.innerHTML = '';
  if (!videos || videos.length === 0) {
    list.innerHTML = '<p style="color:var(--muted);font-size:.85rem;">関連動画がありません</p>';
    return;
  }
  const slice = videos.slice(0, 20);
  const cards = slice.map(v => {
    const card = createRelatedCard(v);
    list.appendChild(card);
    return card;
  });
  lazyLoadRelatedIcons(slice, cards);
}

function setupQualities(formatStreams) {
  const qualityBtns = document.getElementById('qualityBtns');
  const qualityLoading = document.getElementById('qualityLoading');
  const vcQualOpts = document.getElementById('vcQualOpts');
  const vcQualBtn  = document.getElementById('vcQualBtn');
  const player = document.getElementById('videoPlayer');

  if (qualityLoading) qualityLoading.hidden = true;
  if (vcQualOpts) vcQualOpts.innerHTML = '';

  if (!formatStreams || formatStreams.length === 0) return null;

  const preferred = ['1080p60', '1080p', '720p60', '720p', '480p', '360p', '240p', '144p'];
  const sorted = [...formatStreams].sort((a, b) => {
    const ai = preferred.indexOf(a.qualityLabel);
    const bi = preferred.indexOf(b.qualityLabel);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  function setQuality(fmt) {
    const currentTime = player.currentTime;
    const wasPlaying = !player.paused;
    const prevMode = streamOnlyMode;

    if (prevMode === 'audio') {
      // Switching quality while in audio mode → exit audio mode, go normal
      streamOnlyMode = 'normal';
      const _pw = document.getElementById('playerWrap');
      if (_pw) _pw.classList.remove('stream-audio-only');
      const _atb = document.getElementById('audioTrackBar');
      if (_atb) _atb.setAttribute('hidden', '');
      player.muted = volState.muted;
    }
    // If video-only mode: keep mode, keep muted — just change quality
    lastNormalStreamSrc = fmt.url;
    applyVideoSrc(player, fmt.url);
    player.currentTime = currentTime;
    if (prevMode === 'video') player.muted = true;
    if (wasPlaying) player.play().catch(() => {});
    const label = fmt.qualityLabel || fmt.quality || '?';
    if (vcQualOpts) vcQualOpts.querySelectorAll('.vctrls-dd-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.url === fmt.url);
    });
    // In video-only mode keep the "映像のみ" label in the overlay btn and keep track btn active
    if (prevMode === 'video') {
      document.querySelectorAll('#qualityBtns .quality-btn-track[data-track-mode="video"]').forEach(b => b.classList.add('active'));
      document.querySelectorAll('#vcQualOpts .vctrls-dd-opt-track[data-track-mode="video"]').forEach(b => b.classList.add('active'));
      if (vcQualBtn) vcQualBtn.textContent = '映像のみ';
      // Deactivate all videoTrackBtns since quality changed back to muxed stream
      const vtb = document.getElementById('videoTrackBtns');
      if (vtb) vtb.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    } else {
      if (vcQualBtn) vcQualBtn.textContent = label;
    }
    document.querySelectorAll('.vctrls-dd-wrap.dd-open').forEach(w => w.classList.remove('dd-open'));
  }

  sorted.forEach(fmt => {
    const label = fmt.qualityLabel || fmt.quality || '?';

    // Quality buttons only go in the overlay dropdown, not the panel
    // (the panel shows mode buttons: 通常 / 音声のみ / 映像のみ)
    if (vcQualOpts) {
      const opt = document.createElement('button');
      opt.className = 'vctrls-dd-opt';
      opt.textContent = label;
      opt.dataset.url = fmt.url;
      opt.addEventListener('click', () => setQuality(fmt));
      vcQualOpts.appendChild(opt);
    }
  });

  return sorted[0];
}

