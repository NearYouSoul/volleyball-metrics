// Видео через FFmpeg: узнаём кодек и при необходимости готовим файл, который браузер точно проиграет и быстро перематывает.
//   — H.264/VP9/AV1 в mp4/webm — как есть;
//   — правильный кодек в «чужом» контейнере (mkv, mov, avi) — переупаковка без перекодирования (секунды);
//   — HEVC/H.265, ProRes, 10-бит и прочее — перекодирование в H.264 (один раз при импорте, с прогрессом).
// FFmpeg ставится вместе с проектом (пакет ffmpeg-static), интернет на турнире не нужен.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); if (!FFMPEG || !existsSync(FFMPEG)) FFMPEG = null; } catch { FFMPEG = null; }
export const hasFfmpeg = () => !!FFMPEG;

const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);
const BROWSER_EXT = new Set(['.mp4', '.m4v', '.webm']);

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onLine) s.split(/\r|\n/).forEach(onLine);
    });
    p.on('error', reject);
    p.on('close', code => resolve({ code, err }));
  });
}

const toSec = t => { const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };

// Что внутри файла: кодеки, длительность, размер кадра.
export async function probe(file) {
  const { err } = await run(['-hide_banner', '-i', file]);
  const v = /Stream #[^\n]*Video: (\w+)[^\n]*/.exec(err);
  const a = /Stream #[^\n]*Audio: (\w+)/.exec(err);
  const size = v && /, (\d{2,5})x(\d{2,5})/.exec(v[0]);
  return {
    vcodec: v?.[1] ?? null,
    acodec: a?.[1] ?? null,
    tenBit: !!(v && /p10|p12/.test(v[0])), // 10-битное видео браузеры не играют
    duration: toSec(/Duration: ([\d:.]+)/.exec(err)?.[1] ?? ''),
    width: size ? +size[1] : null, height: size ? +size[2] : null,
  };
}

// Решение: 'ready' — как есть, 'remux' — переупаковать, 'transcode' — перекодировать.
export function plan(info, ext) {
  if (!info.vcodec) return 'transcode';
  const videoOk = BROWSER_VIDEO.has(info.vcodec) && !info.tenBit;
  const audioOk = !info.acodec || BROWSER_AUDIO.has(info.acodec);
  if (videoOk && audioOk && BROWSER_EXT.has(ext)) return 'ready';
  if (videoOk) return 'remux';
  return 'transcode';
}

// Готовим mp4. Частые ключевые кадры (каждые 2 с) — точная перемотка и шаг по кадрам.
// faststart — индекс в начале файла: видео открывается сразу, без чтения всего файла.
export async function convert(src, dst, info, mode, onProgress) {
  const audio = !info.acodec ? ['-an'] : BROWSER_AUDIO.has(info.acodec) && info.acodec !== 'vorbis' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
  const video = mode === 'remux' ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '25', '-sc_threshold', '0'];
  const args = ['-hide_banner', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', ...video, ...audio, '-movflags', '+faststart', dst];
  const { code, err } = await run(args, line => {
    const t = /time=([\d:.]+)/.exec(line);
    if (t && info.duration) onProgress?.(Math.min(0.99, toSec(t[1]) / info.duration));
  });
  if (code !== 0) throw new Error(err.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300));
}
