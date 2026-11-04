// Очередь нажатий пульта: если связь с ноутбуком пропала (Wi-Fi, раздача с телефона), нажатия не теряются.
// Событие сразу применяется на экране и кладётся в очередь (localStorage — переживает и обновление страницы);
// очередь отправляется по порядку, а при обрыве — повторяется каждые 2 секунды, пока связь не вернётся.
// У каждого события свой cid: если ответ потерялся и событие ушло дважды, сервер второй раз его не добавит.
// «Отмена» отправляется с ожидаемым числом событий — повтор не удалит лишнего.

const KEY = id => 'vb.queue.' + id;
const load = id => { try { return JSON.parse(localStorage.getItem(KEY(id))) ?? []; } catch { return []; } };
const save = (id, q) => { try { q.length ? localStorage.setItem(KEY(id), JSON.stringify(q)) : localStorage.removeItem(KEY(id)); } catch { /* приватный режим */ } };
export const cid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function createSync({ getMatch, setMatch, onStatus }) {
  let queue = [], matchId = null, flushing = false, online = true, timer = null;
  const status = () => onStatus?.({ online, pending: queue.length });

  // Применяем операцию к локальной копии матча — экран обновляется сразу.
  const applyLocal = op => {
    const m = getMatch();
    if (!m) return;
    if (op.op === 'post') m.events.push(op.ev);
    if (op.op === 'undo') m.events.pop();
    setMatch(m);
  };

  async function send(op) {
    const id = matchId;
    const url = op.op === 'post' ? `/api/matches/${id}/events` : `/api/matches/${id}/events/last?expect=${op.expect}`;
    const r = await fetch(url, { method: op.op === 'post' ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json' }, body: op.op === 'post' ? JSON.stringify(op.ev) : undefined });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  async function flush() {
    if (flushing || !matchId) return;
    flushing = true;
    let last = null;
    while (queue.length) {
      try { last = await send(queue[0]); queue.shift(); save(matchId, queue); online = true; }
      catch { online = false; status(); clearTimeout(timer); timer = setTimeout(flush, 2000); break; }
    }
    flushing = false;
    // Всё ушло — берём состояние с сервера (оно главное), иначе остаёмся на локальном.
    if (!queue.length && last && last.id === matchId) setMatch(last);
    status();
  }

  return {
    // Открыли матч: подхватываем неотправленное (например, страницу обновили без связи) поверх серверной версии.
    attach(match) {
      matchId = match?.id ?? null;
      queue = matchId ? load(matchId) : [];
      if (queue.length) { for (const op of queue) applyLocal(op); flush(); }
      status();
    },
    post(ev) { const op = { op: 'post', ev: { ...ev, cid: cid() } }; queue.push(op); save(matchId, queue); applyLocal(op); flush(); },
    undo() {
      const m = getMatch();
      if (!m?.events.length) return;
      // Последнее ещё не ушло на сервер — просто убираем его из очереди.
      const lastOp = queue.at(-1);
      if (lastOp?.op === 'post' && !flushing) { queue.pop(); save(matchId, queue); m.events.pop(); setMatch(m); status(); return; }
      const op = { op: 'undo', expect: m.events.length };
      queue.push(op); save(matchId, queue); applyLocal(op); flush();
    },
    pending: () => queue.length,
  };
}

// Плашка «нет связи» вверху экрана.
export function statusBadge({ online, pending }) {
  let el = document.getElementById('syncBadge');
  if (!el) {
    el = document.createElement('div');
    el.id = 'syncBadge';
    el.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:100;padding:6px 12px;border-radius:999px;font:600 13px Inter,system-ui,sans-serif;box-shadow:0 6px 20px rgb(0 0 0/.4);transition:opacity .2s;pointer-events:none';
    document.body.append(el);
  }
  const show = !online || pending > 0;
  el.style.opacity = show ? 1 : 0;
  el.style.background = online ? '#e9eaec' : '#ff6363';
  el.style.color = online ? '#15161a' : '#1a0909';
  el.textContent = online ? `Отправляю… ${pending}` : `Нет связи с ноутбуком · в очереди ${pending} — ничего не потеряется`;
}
