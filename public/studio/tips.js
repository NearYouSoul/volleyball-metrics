// Режим подсказок (кнопка «?» в верхней панели).
// Включён — наведите курсор на кнопку или любой рабочий элемент и задержите на ~0,8 с: рядом появится подсказка.
// Выключен — никаких подсказок: ни всплывающих, ни поясняющих абзацев в блоках (они не занимают место).
// Подсказка элемента — атрибут data-tip (обычный title тоже подходит: он превращается в data-tip,
// чтобы браузер не показывал свою подсказку поверх). Поясняющий текст в блоке — элемент с классом
// tip-inline: он скрыт, а его текст становится подсказкой блока, в котором стоит.
const DELAY = 800; // мс — сколько держать курсор неподвижно

export function initTips({ get, set, button, onChange }) {
  let on = !!get();
  const tip = document.createElement('div');
  tip.className = 'tipbox';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);

  const adopt = root => {
    if (!root.querySelectorAll) return;
    const titled = root.matches?.('[title]') ? [root, ...root.querySelectorAll('[title]')] : root.querySelectorAll('[title]');
    for (const el of titled) {
      if (el.tagName === 'svg' || el.closest('svg')) continue;
      el.dataset.tip = el.getAttribute('title');
      el.removeAttribute('title');
    }
    const inl = root.matches?.('.tip-inline') ? [root, ...root.querySelectorAll('.tip-inline')] : root.querySelectorAll('.tip-inline');
    for (const el of inl) {
      const host = el.parentElement;
      if (!host || el.dataset.adopted) continue;
      el.dataset.adopted = '1';
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (text && !(host.dataset.tip || '').includes(text)) host.dataset.tip = host.dataset.tip ? `${host.dataset.tip}\n${text}` : text;
    }
  };
  adopt(document.body);
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') { if (m.target.hasAttribute('title')) adopt(m.target); }
      else for (const n of m.addedNodes) if (n.nodeType === 1) adopt(n);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  let timer = null, target = null, mx = 0, my = 0;
  const hide = () => { clearTimeout(timer); timer = null; tip.classList.remove('on'); };
  const show = () => {
    if (!target || !document.contains(target)) return;
    tip.textContent = target.dataset.tip;
    tip.classList.add('on');
    const r = tip.getBoundingClientRect(), pad = 8;
    let x = mx + 14, y = my + 18;
    if (x + r.width > innerWidth - pad) x = Math.max(pad, mx - r.width - 10);
    if (y + r.height > innerHeight - pad) y = Math.max(pad, my - r.height - 12);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    if (!on) return;
    const el = e.target.closest?.('[data-tip]');
    if (el !== target) { hide(); target = el; }
    // Подсказка — только когда курсор остановился: каждое движение перезапускает отсчёт.
    if (target && !tip.classList.contains('on')) { clearTimeout(timer); timer = setTimeout(show, DELAY); }
  }, { passive: true });
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) addEventListener(ev, hide, { passive: true, capture: true });
  document.addEventListener('mouseleave', hide);

  const apply = () => {
    document.body.classList.toggle('tips-on', on);
    button?.classList.toggle('on', on);
    if (!on) { hide(); target = null; }
  };
  apply();
  return {
    toggle() { on = !on; set(on); apply(); onChange?.(on); return on; },
    get on() { return on; },
  };
}
