// Режимы сбора статистики. Матч и партии общие, а статистика в каждом режиме своя и не суммируется:
// студия — 3D по видео, ручной — кнопками на компьютере, экспресс — кто закончил розыгрыш (пульт).
export const MODES = {
  studio: { name: 'Студия PRO', hint: '3D-площадка и видео: каждое касание с точками', page: 'studio.html' },
  manual: { name: 'Ручной PRO', hint: 'каждое касание кнопками, без 3D', page: 'detailed.html' },
  express: { name: 'Экспресс stat', hint: 'кто закончил розыгрыш и чем, с телефона или здесь', page: 'quick.html' },
};
export const MODE_KEYS = Object.keys(MODES);
export const emptyStats = () => Object.fromEntries(MODE_KEYS.map(k => [k, { events: [] }]));

// Старый файл матча (режим в поле mode, один список событий) → новый. Смешанный матч целиком уходит в студию.
export function migrate(m) {
  if (m.stats) { for (const k of MODE_KEYS) m.stats[k] ??= { events: [] }; return m; }
  const { mode, events = [], ...rest } = m;
  const stats = emptyStats();
  const key = mode === 'quick' ? 'express' : events.some(e => e.to || e.from || e.vt != null) ? 'studio' : 'manual';
  stats[key].events = events;
  return { ...rest, stats };
}
// Матч глазами одного режима: движки и экраны ввода работают с обычным списком events.
export function sheet(m, src) {
  const { stats, ...rest } = m;
  return { ...rest, src, events: stats[src].events };
}
