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

const SERVER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Read the whole photo into memory before sending. Phone browsers otherwise read it lazily
 * while uploading, and photos kept in cloud storage (Google Photos, iCloud) or edited by the
 * phone mid-read make the browser abort with "Failed to fetch" before anything is sent.
 */
async function readPhoto(file: File): Promise<Blob> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new ApiErr('read', "Couldn't read that photo. If it's in the cloud, open it in your gallery first, then try again.", 0);
  }
  if (SERVER_TYPES.includes(file.type)) return new Blob([bytes], { type: file.type });
  // HEIC and other formats the server can't open: let the phone convert it to JPEG.
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || 'application/octet-stream' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.92));
    if (jpeg) return jpeg;
  } catch {}
  return new Blob([bytes], { type: 'application/octet-stream' }); // let the server give its own message
}

/** Upload a photo as the raw request body, with one automatic retry if the connection drops. */
export async function apiUpload<T = unknown>(path: string, file: File): Promise<T> {
  const blob = await readPhoto(file);
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      res = await fetch(path, { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob, credentials: 'same-origin' });
    } catch {
      if (attempt === 1) throw new ApiErr('network', 'The upload was interrupted. Check your connection and try again.', 0);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const data = await res!.json().catch(() => ({}));
  if (!res!.ok) {
    throw new ApiErr(data.error ?? 'error', data.message ?? (res!.status === 413 ? 'That photo is too large (30 MB max).' : `Upload failed (error ${res!.status}).`), res!.status);
  }
  return data as T;
}
