/* Dashboard webview — dom. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */


export type Child = Node | string | number | null | undefined | false | Child[];

export type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value') (el as HTMLInputElement).value = String(v);
      else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
      else if (k === 'disabled') (el as HTMLButtonElement).disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, children);
  return el;
}

export function add(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** Codicon (VS Code's icon font). Decorative: pair it with text or an aria-label. */
export function icon(name: string, cls = ''): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name} ${cls}`.trim(), 'aria-hidden': 'true' });
}

export function chip(text: string, kind = '', title?: string) {
  return h('span', { class: `chip ${kind}`, title }, text);
}

export function sevIcon(sev: string) {
  const map: Record<string, string> = { error: 'error', high: 'error', warning: 'warning', info: 'info' };
  return h('span', { class: `sev sev-${sev}`, role: 'img', 'aria-label': sev }, icon(map[sev] ?? 'circle-filled'));
}

export function button(label: string, onClick: () => void, opts: { kind?: 'primary' | 'secondary' | 'danger' | 'link'; disabled?: boolean; title?: string } = {}) {
  return h('button', { class: `btn ${opts.kind ?? 'secondary'}`, onClick, disabled: opts.disabled, title: opts.title, type: 'button' }, label);
}

/** Grey placeholder lines while something loads. */
export function skeleton(lines: number): Node {
  return h('div', { class: 'skeleton', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('div', { class: `sk-line w${(i * 37) % 3}` })));
}

export function select(value: string, options: Array<[string, string]>, onChange: (v: string) => void, label: string) {
  return h(
    'label',
    { class: 'select' },
    h('span', { class: 'sr' }, label),
    h(
      'select',
      { onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value), 'aria-label': label },
      options.map(([v, t]) => h('option', { value: v, selected: v === value ? true : undefined }, t)),
    ),
  );
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attrs: Record<string, string | number>, ...children: Array<Node | string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

export const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

