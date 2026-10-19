/* Dashboard webview — dom. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */


export type Child = Node | string | number | null | undefined | false | Child[];

export type Props = Record<string, unknown> | null;

const EVENT_PROP_PREFIX = 'on';

/** Creates an element: `class`, `onX` listeners, form properties, other keys as attributes; strings become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key.startsWith(EVENT_PROP_PREFIX) && typeof value === 'function') element.addEventListener(key.slice(EVENT_PROP_PREFIX.length).toLowerCase(), value as EventListener);
    else if (key === 'value') (element as HTMLInputElement).value = String(value);
    else if (key === 'checked') (element as HTMLInputElement).checked = !!value;
    else if (key === 'disabled') (element as HTMLButtonElement).disabled = !!value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  add(element, children);
  return element;
}

export function add(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) add(parent, child);
    else parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Codicon (VS Code's icon font). Decorative: pair it with text or an aria-label. */
export function icon(name: string, cls = ''): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name} ${cls}`.trim(), 'aria-hidden': 'true' });
}

export function chip(text: string, kind = '', title?: string) {
  return h('span', { class: `chip ${kind}`, title }, text);
}

const SEVERITY_ICON: Record<string, string> = { error: 'error', high: 'error', warning: 'warning', info: 'info' };

export function sevIcon(severity: string) {
  return h('span', { class: `sev sev-${severity}`, role: 'img', 'aria-label': severity }, icon(SEVERITY_ICON[severity] ?? 'circle-filled'));
}

export function button(label: string, onClick: () => void, options: { kind?: 'primary' | 'secondary' | 'danger' | 'link'; disabled?: boolean; title?: string } = {}) {
  return h('button', { class: `btn ${options.kind ?? 'secondary'}`, onClick, disabled: options.disabled, title: options.title, type: 'button' }, label);
}

/** The CSS defines three placeholder line widths: .w0, .w1 and .w2. */
const SKELETON_WIDTH_COUNT = 3;

/** Grey placeholder lines while something loads. */
export function skeleton(lines: number): Node {
  const line = (index: number) => h('div', { class: `sk-line w${index % SKELETON_WIDTH_COUNT}` });
  return h('div', { class: 'skeleton', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, index) => line(index)));
}

export function select(value: string, options: Array<[string, string]>, onChange: (value: string) => void, label: string) {
  return h(
    'label',
    { class: 'select' },
    h('span', { class: 'sr' }, label),
    h(
      'select',
      { onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value), 'aria-label': label },
      options.map(([optionValue, text]) => h('option', { value: optionValue, selected: optionValue === value ? true : undefined }, text)),
    ),
  );
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attributes: Record<string, string | number>, ...children: Array<Node | string>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  for (const child of children) element.append(child);
  return element;
}

/** Shortens `text` to `maxLength` characters, ending in "…" when cut. */
export const clip = (text: string, maxLength: number) => (text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text);

