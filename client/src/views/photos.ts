import { PROFILE } from '../../../shared/config.js';
import type { PhotoDTO } from '../../../shared/types.js';
import { toast } from '../core.js';
import { apiUpload, h } from '../dom.js';

/** Full-screen photo viewer. Tap outside or Close to dismiss. */
export function lightbox(url: string) {
  const d = h('dialog', { class: 'lightbox' },
    h('img', { src: url, alt: 'Photo' }),
    h('button', { type: 'button', class: 'primary', onclick: (() => d.close()) as EventListener }, 'Close'));
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.append(d);
  d.showModal();
}

/**
 * Let the member pick one or more photos and upload them one by one with progress.
 * Resolves with the photos that uploaded (failures are reported and skipped).
 */
export function uploadPhotos(toPrivate: boolean, multiple = true): Promise<PhotoDTO[]> {
  return new Promise((resolve) => {
    // Listing the types (not image/*) makes iPhones hand over JPEG instead of HEIC.
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple, class: 'visually-hidden' });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      input.remove();
      const done: PhotoDTO[] = [];
      const bar = h('div', { class: 'toast', role: 'status' });
      document.body.append(bar);
      for (const [i, f] of files.entries()) {
        bar.textContent = `Uploading ${i + 1} of ${files.length}…`;
        if (f.size > PROFILE.photoMaxBytes) {
          toast(`${f.name} is over ${Math.round(PROFILE.photoMaxBytes / 1024 / 1024)} MB, skipped.`, true);
          continue;
        }
        try {
          done.push(await apiUpload<PhotoDTO>(`/api/me/photos${toPrivate ? '?private=1' : ''}`, f));
        } catch (e) {
          toast(`${f.name}: ${(e as Error).message}`, true);
        }
      }
      bar.remove();
      if (done.length) toast(`${done.length} photo${done.length === 1 ? '' : 's'} added${toPrivate ? ' to your private album' : ''}.`);
      resolve(done);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve([]); });
    input.click();
  });
}
