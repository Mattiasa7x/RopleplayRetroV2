/** Tiny helpers shared by the chat app and the moderator console. No framework, no innerHTML. */

export class ApiErr extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

function clientId(): string | undefined {
  try {
    let id = localStorage.getItem('cid');
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem('cid', id);
    }
    return id;
  } catch {
    return undefined; // private mode etc.: fine, the cookie still works
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const cid = clientId();
  if (cid) headers['x-client-id'] = cid;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(data.error ?? 'error', data.message ?? 'Something went wrong.', res.status);
  return data as T;
}

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Build an element. Text is always set as text, never parsed as HTML (no XSS from chat lines). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function mount(root: HTMLElement, ...nodes: Child[]) {
  root.replaceChildren(...(nodes.filter(Boolean) as (Node | string)[]));
}

export function timeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Send a file as the raw request body (used for photo uploads). */
export async function apiUpload<T = unknown>(path: string, file: File): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': file.type }, body: file, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(data.error ?? 'error', data.message ?? (res.status === 413 ? 'That photo is too large (5 MB max).' : 'Upload failed.'), res.status);
  return data as T;
}
