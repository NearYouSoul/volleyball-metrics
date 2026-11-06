// Плеер студии: файл идёт напрямую в <video>, YouTube — через поддельный API, чтобы тесты работали без сети.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, youtubeId } from '../public/studio/player.js';

globalThis.location ??= { origin: 'http://localhost:4200' };

function fakeVideo() {
  const calls = [], heard = {};
  return {
    calls, heard, src: '', currentTime: 12, duration: 90, paused: true, seeking: false, playbackRate: 1, videoWidth: 1920, videoHeight: 1080, style: { from: 'video' },
    play() { calls.push('play'); return Promise.resolve(); }, pause() { calls.push('pause'); }, load() { calls.push('load'); },
    removeAttribute(n) { calls.push('remove ' + n); }, addEventListener(t, fn) { (heard[t] ??= []).push(fn); },
  };
}
// Ведёт себя как настоящий плеер: команды не срабатывают мгновенно, состояние приходит отдельным событием.
function fakeYoutube() {
  const state = { calls: [], t: 0, duration: 600, events: null };
  const target = {
    getCurrentTime: () => state.t, getDuration: () => state.duration, getAvailablePlaybackRates: () => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    getVideoData: () => ({ title: 'Финал' }),
    cueVideoById: id => state.calls.push('cue ' + id), playVideo: () => state.calls.push('play'), pauseVideo: () => state.calls.push('pause'),
    stopVideo: () => state.calls.push('stop'), seekTo: t => state.calls.push('seek ' + t), setPlaybackRate: r => state.calls.push('rate ' + r),
  };
  const YT = { Player: function (frame, opts) { state.opts = opts; state.events = opts.events; } };
  return { state, YT, target, ready: () => state.events.onReady({ target }), set: s => state.events.onStateChange({ data: s }) };
}
const flush = () => new Promise(r => setImmediate(r));
async function openYoutube(opts = {}) {
  const el = fakeVideo(), host = { hidden: true, style: { from: 'host' } }, fake = fakeYoutube(), errors = [];
  const p = createPlayer(el, { host, frame: {}, onError: m => errors.push(m), load: async () => fake.YT });
  p.openYoutube('dQw4w9WgXcQ', opts);
  await flush();
  fake.ready();
  return { p, el, host, fake, errors };
}

test('ссылки YouTube: все обычные виды и отказ на чужие', () => {
  for (const s of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ', '  https://youtu.be/dQw4w9WgXcQ  '])
    assert.equal(youtubeId(s), 'dQw4w9WgXcQ', s);
  for (const s of ['', null, 'https://vimeo.com/123456', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'просто текст'])
    assert.equal(youtubeId(s), null, String(s));
});

test('файл: всё идёт прямо в <video>, как раньше', async () => {
  const el = fakeVideo();
  const p = createPlayer(el, { host: { hidden: true, style: {} }, frame: {} });
  p.src = '/media/a.mp4'; p.currentTime = 40; p.playbackRate = 0.1;
  assert.equal(el.src, '/media/a.mp4');
  assert.equal(el.currentTime, 40);
  assert.equal(el.playbackRate, 0.1); // скорости файла не ограничиваются
  assert.equal(p.currentTime, 40);
  assert.equal(p.duration, 90);
  assert.equal(p.videoWidth, 1920);
  assert.equal(p.style.from, 'video');
  await p.play(); p.pause();
  assert.deepEqual(el.calls, ['play', 'pause']);
  const fn = () => {};
  p.addEventListener('seeked', fn);
  assert.deepEqual(el.heard.seeked, [fn]);
  assert.equal(p.isYoutube, false);
});

test('YouTube: открывается поверх видео, файл останавливается', async () => {
  const { p, el, host } = await openYoutube({ duration: 300 });
  assert.equal(p.isYoutube, true);
  assert.ok(p.src);
  assert.equal(host.hidden, false);
  assert.ok(el.calls.includes('remove src'));
  assert.equal(p.duration, 300);
  assert.equal(p.videoWidth, 0); // кадры недоступны: мини-карта не рисуется
  assert.equal(p.style.from, 'host');
  assert.equal(p.title, 'Финал');
});

test('YouTube: пауза и пуск срабатывают сразу, не дожидаясь плеера', async () => {
  const { p, fake } = await openYoutube();
  assert.equal(p.paused, true);
  await p.play();
  assert.equal(p.paused, false);
  fake.set(1);
  p.pause();
  assert.equal(p.paused, true);
  assert.ok(fake.state.calls.includes('pause'));
});

test('YouTube: перемотка стоит на новом месте сразу и не сбивается старым временем', async () => {
  const { p, fake } = await openYoutube();
  fake.state.t = 10; p.tick();
  let seeked = 0; p.addEventListener('seeked', () => seeked++);
  p.currentTime = 100;
  assert.equal(p.currentTime, 100);
  assert.equal(p.seeking, true);
  p.tick(); // плеер ещё отвечает старым временем
  assert.equal(p.currentTime, 100);
  fake.state.t = 100; p.tick();
  assert.equal(p.seeking, false);
  assert.equal(seeked, 1);
  // Шаги по кадрам складываются, хотя плеер отвечает не сразу.
  p.currentTime = p.currentTime + 0.04;
  p.currentTime = p.currentTime + 0.04;
  assert.ok(Math.abs(p.currentTime - 100.08) < 1e-9);
});

test('YouTube: перемотка незапущенного видео не включает его', async () => {
  const { p, fake } = await openYoutube();
  p.currentTime = 50;
  fake.set(1); // seekTo сам запустил ролик
  assert.ok(fake.state.calls.includes('pause'));
  assert.equal(p.paused, true);
});

test('YouTube: время идёт между ответами плеера с учётом скорости', async () => {
  const { p, fake } = await openYoutube();
  fake.state.t = 20; p.playbackRate = 2;
  await p.play(); fake.set(1);
  await new Promise(r => setTimeout(r, 60));
  assert.ok(p.currentTime > 20.05 && p.currentTime < 20.6, String(p.currentTime));
  assert.ok(fake.state.calls.includes('rate 2'));
});

test('YouTube: скорости — ближайшие из доступных, ×3 становится ×2', async () => {
  const { p } = await openYoutube();
  p.playbackRate = 0.1; assert.equal(p.playbackRate, 0.25);
  p.playbackRate = 3; assert.equal(p.playbackRate, 2);
  p.playbackRate = 0.75; assert.equal(p.playbackRate, 0.75);
});

test('YouTube: события для студии — длина, ход времени, пауза', async () => {
  const { p, fake } = await openYoutube();
  const got = [];
  for (const t of ['loadedmetadata', 'timeupdate', 'play', 'pause']) p.addEventListener(t, () => got.push(t));
  p.tick();
  assert.deepEqual(got, ['loadedmetadata']);
  assert.equal(p.duration, 600);
  await p.play(); fake.set(1); p.tick();
  p.pause(); fake.set(2);
  assert.deepEqual(got, ['loadedmetadata', 'play', 'timeupdate', 'pause']);
});

test('YouTube: возврат к файлу убирает плеер; ошибка ролика понятна; другой ролик не создаёт второй плеер', async () => {
  const { p, el, host, fake, errors } = await openYoutube();
  fake.state.events.onError({ data: 150 });
  assert.match(errors[0], /запретил/);
  p.openYoutube('aaaaaaaaaaa');
  assert.ok(fake.state.calls.includes('cue aaaaaaaaaaa'));
  p.src = '/media/b.mp4';
  assert.equal(p.isYoutube, false);
  assert.equal(host.hidden, true);
  assert.equal(el.src, '/media/b.mp4');
  assert.equal(p.style.from, 'video');
});

test('YouTube: команды до готовности плеера не теряются; нет связи — понятная ошибка', async () => {
  const fake = fakeYoutube(), el = fakeVideo();
  const p = createPlayer(el, { host: { hidden: true, style: {} }, frame: {}, load: async () => fake.YT });
  p.openYoutube('dQw4w9WgXcQ');
  p.currentTime = 42; await p.play();
  await flush(); fake.ready();
  assert.ok(fake.state.calls.includes('seek 42') && fake.state.calls.includes('play'));
  const errors = [];
  const q = createPlayer(fakeVideo(), { host: { hidden: true, style: {} }, frame: {}, onError: m => errors.push(m), load: async () => { throw new Error('нет'); } });
  q.openYoutube('dQw4w9WgXcQ');
  await flush(); await flush();
  assert.match(errors[0], /интернет/);
  q.src = '';
});
