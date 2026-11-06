// Плеер студии: один интерфейс для файла и для YouTube.
// Снаружи он выглядит как обычный <video> (currentTime, paused, play…), поэтому студии не важно, что играет.
// Файл — всё напрямую в <video>. YouTube — через IFrame Player API: он отвечает с задержкой, поэтому время
// и паузу держим здесь, а между ответами плеера время считаем сами, чтобы касания попадали точно.

// Ссылка или голый id ролика → id из 11 символов. Не YouTube — null.
export function youtubeId(text) {
  const s = String(text ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const id = host === 'youtu.be' ? u.pathname.split('/')[1]
    : host === 'youtube.com' || host === 'youtube-nocookie.com'
      ? u.searchParams.get('v') ?? /^\/(?:embed|shorts|live|v)\/([^/]+)/.exec(u.pathname)?.[1]
      : null;
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

const ERRORS = {
  2: 'YouTube: неверная ссылка на видео',
  5: 'YouTube: плеер не смог открыть это видео',
  100: 'YouTube: видео удалено или приватное',
  101: 'YouTube: владелец запретил показ на других сайтах',
  150: 'YouTube: владелец запретил показ на других сайтах',
};
const STATE = { ended: 0, playing: 1, paused: 2 };
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

let apiLoading = null;
function loadYoutubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiLoading ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiLoading = null; s.remove(); reject(new Error('нет связи')); };
    document.head.append(s);
  });
  return apiLoading;
}

// el — <video>; host — блок поверх него; frame — место внутри host, куда YouTube вставит плеер.
export function createPlayer(el, { host, frame, onError = () => {}, load = loadYoutubeApi }) {
  const handlers = {};
  const emit = type => (handlers[type] ?? []).forEach(fn => fn());

  let id = null;         // открытый ролик; null — играет файл
  let api = null, creating = false, shownId = null, timer = null;
  let base = 0, baseAt = 0, lastReal = 0; // время: последнее известное и когда оно получено
  let running = false;   // плеер действительно играет
  let wantPaused = true, wantAt = 0, told = true;
  let seekTarget = null, seekFrom = 0, seekAt = 0;
  let dur = 0, meta = false, rate = 1;

  const now = () => performance.now();
  const time = () => (running ? Math.min(base + ((now() - baseAt) / 1000) * rate, dur || Infinity) : base);
  const setBase = t => { base = t; baseAt = now(); };
  const announce = paused => { if (paused !== told) { told = paused; emit(paused ? 'pause' : 'play'); } };
  const nearestRate = r => (api?.getAvailablePlaybackRates?.() ?? RATES).reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a));

  function sample() { if (api && seekTarget === null) { lastReal = api.getCurrentTime(); setBase(lastReal); } }

  function tick() {
    if (!api || !id) return;
    const real = api.getCurrentTime();
    if (seekTarget !== null) {
      const landed = real !== seekFrom && Math.abs(real - seekTarget) < 1.2;
      if (!landed && now() - seekAt < 1000) return;
      if (landed && !wantPaused) setBase(real);
      lastReal = real;
      seekTarget = null;
      emit('seeked');
    } else if (real !== lastReal) { lastReal = real; setBase(real); }
    if (!dur) dur = api.getDuration() || 0;
    if (dur && !meta) { meta = true; emit('loadedmetadata'); }
    if (running) emit('timeupdate');
  }

  function onState(s) {
    sample();
    running = s === STATE.playing;
    if (s === STATE.playing) {
      if (wantPaused) { running = false; api.pauseVideo(); return; } // seekTo из «не запущено» сам включает видео
      api.setPlaybackRate(rate);
      announce(false);
    } else if (s === STATE.paused || s === STATE.ended) {
      if (s === STATE.paused && !wantPaused && now() - wantAt < 800) { api.playVideo(); return; } // пауза от прошлой команды
      wantPaused = true;
      announce(true);
    }
  }

  function start() {
    if (api) { shownId = id; api.cueVideoById(id); return; }
    if (creating) return;
    creating = true;
    load().then(YT => {
      shownId = id;
      new YT.Player(frame, {
        width: '100%', height: '100%', videoId: id,
        playerVars: { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: e => {
            api = e.target;
            creating = false;
            if (!id) return;
            if (id !== shownId) { shownId = id; api.cueVideoById(id); }
            if (base > 0) player.currentTime = base;
            if (!wantPaused) api.playVideo();
          },
          onStateChange: e => onState(e.data),
          onError: e => onError(ERRORS[e.data] ?? `YouTube: видео не открылось (код ${e.data})`),
        },
      });
    }).catch(() => { creating = false; onError('Не удалось подключиться к YouTube. Проверьте интернет'); });
  }

  function closeYoutube() {
    if (!id) return;
    id = null;
    clearInterval(timer);
    api?.stopVideo();
    host.hidden = true;
    host.style.transform = '';
    running = false; wantPaused = true; seekTarget = null;
    announce(true);
  }

  const player = {
    el,
    get isYoutube() { return !!id; },
    get title() { return id ? api?.getVideoData?.()?.title ?? '' : ''; },
    openYoutube(next, { duration = 0 } = {}) {
      closeYoutube();
      el.pause(); el.removeAttribute('src'); el.load();
      id = next;
      setBase(0); lastReal = 0;
      dur = duration; meta = false;
      host.hidden = false;
      timer = setInterval(tick, 100);
      timer.unref?.();
      start();
    },
    get src() { return id ? `youtube:${id}` : el.src; },
    set src(v) { closeYoutube(); el.src = v; },
    removeAttribute(name) { closeYoutube(); el.removeAttribute(name); },
    load() { el.load(); },
    get currentTime() { return id ? time() : el.currentTime; },
    set currentTime(t) {
      if (!id) { el.currentTime = t; return; }
      setBase(t);
      if (!api) return; // применится, когда плеер будет готов
      seekFrom = api.getCurrentTime(); seekTarget = t; seekAt = now();
      api.seekTo(t, true);
    },
    get duration() { return id ? dur : el.duration; },
    get paused() { return id ? wantPaused : el.paused; },
    get seeking() { return id ? seekTarget !== null : el.seeking; },
    get playbackRate() { return id ? rate : el.playbackRate; },
    set playbackRate(r) {
      if (!id) { el.playbackRate = r; return; }
      rate = nearestRate(r); // у YouTube только свои скорости: от 0,25× до 2×
      setBase(time());
      api?.setPlaybackRate(rate);
    },
    get videoWidth() { return id ? 0 : el.videoWidth; },
    get videoHeight() { return id ? 0 : el.videoHeight; },
    get style() { return id ? host.style : el.style; },
    play() {
      if (!id) return el.play();
      wantPaused = false; wantAt = now();
      api?.playVideo();
      return Promise.resolve();
    },
    pause() {
      if (!id) return el.pause();
      setBase(time());
      running = false; wantPaused = true;
      api?.pauseVideo();
    },
    addEventListener(type, fn) { el.addEventListener(type, fn); (handlers[type] ??= []).push(fn); },
    tick, // для тестов: тот же шаг, что и по таймеру
  };
  return player;
}
