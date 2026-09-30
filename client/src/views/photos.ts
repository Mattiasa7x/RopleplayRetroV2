import { PROFILE } from '../../../shared/config.js';
import type { PhotoDTO } from '../../../shared/types.js';
import { toast } from '../core.js';
import { ApiErr, apiUpload, h } from '../dom.js';

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
 * Let the member pick one or more photos (several at once) and upload them one by one with
 * progress. Resolves with the photos that uploaded (failures are reported and skipped; a full
 * album stops the rest).
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
          if (e instanceof ApiErr && e.code === 'album_full') {
            const left = files.length - i;
            toast(`${e.message}${left > 1 ? ` ${left} photo${left === 1 ? '' : 's'} not uploaded.` : ''}`, true);
            break;
          }
          toast(`${f.name}: ${(e as Error).message}`, true);
        }
      }
      bar.remove();
      const n = done.length;
      const waiting = done.filter((p) => p.pending).length;
      if (n) toast(`${n} photo${n === 1 ? '' : 's'} added${toPrivate ? ' to your private album' : ''}.${waiting ? ` ${waiting === n ? (n === 1 ? 'It' : 'They') : `${waiting} of them`} will show on your profile once approved.` : ''}`);
      resolve(done);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve([]); });
    input.click();
  });
}
