import { PROFILE } from '../../../shared/config.js';
import type { CommentDTO, CommentPageDTO } from '../../../shared/types.js';
import { avatar, state, timeAgo, toast } from '../core.js';
import { api, h } from '../dom.js';
import { composer, reportContent } from './home.js';

interface Opts {
  /** e.g. /api/profiles/Tester/comments or /api/photos/12/comments */
  url: string;
  deleteUrl: (id: string) => string;
  reportKind: 'comment' | 'photo_comment';
  canComment: boolean;
  placeholder: string;
  /** Profile preview: the newest few plus a link to the full list. */
  preview?: { size: number; moreHref: string };
}

function commentItem(c: CommentDTO, o: Opts, onGone: () => void): HTMLElement {
  const me = state.me!;
  const li = h('li', { class: 'post' },
    h('a', { href: `/profile/${c.author.handle}`, class: 'post-head' }, avatar(c.author.avatar, c.author.handle), h('strong', {}, c.author.handle)),
    h('p', { class: 'post-body' }, c.body),
    h('div', { class: 'post-meta' },
      h('span', { class: 'muted' }, timeAgo(c.createdAt)),
      c.canDelete ? h('button', { type: 'button', class: 'link', onclick: (async () => {
        if (!confirm('Delete this comment?')) return;
        try { await api(o.deleteUrl(c.id), { method: 'DELETE' }); li.remove(); onGone(); } catch (e) { toast((e as Error).message, true); }
      }) as EventListener }, 'Delete') : null,
      c.author.id !== me.id ? h('button', { type: 'button', class: 'link', onclick: (() => void reportContent(o.reportKind, c.id)) as EventListener }, 'Report') : null));
  return li;
}

/**
 * A comment box and comments, newest first. In preview mode it shows the newest few and a
 * button to the full list; otherwise it pages through them 10 at a time.
 */
export function commentThread(o: Opts): HTMLElement {
  const list = h('ul', { class: 'posts comment-list' });
  const footer = h('div', { class: 'comment-footer' });
  let page = 1;

  async function load(p = page) {
    const size = o.preview?.size ?? PROFILE.commentsPerPage;
    const r = await api<CommentPageDTO>(`${o.url}?page=${p}&size=${size}`);
    page = r.page;
    list.replaceChildren(...r.comments.map((c) => commentItem(c, o, () => void load())));
    if (!r.comments.length) list.append(h('li', { class: 'muted empty' }, 'No comments yet.'));
    if (o.preview) {
      footer.replaceChildren(r.total > r.comments.length
        ? h('a', { href: o.preview.moreHref, class: 'button quiet small-btn' }, `See all ${r.total} comments`)
        : '');
    } else {
      footer.replaceChildren(r.pages > 1
        ? h('div', { class: 'pager' },
            h('button', { type: 'button', class: 'quiet', disabled: r.page <= 1, onclick: (() => void load(r.page - 1).then(top)) as EventListener }, '‹ Newer'),
            h('span', { class: 'muted small' }, `Page ${r.page} of ${r.pages}`),
            h('button', { type: 'button', class: 'quiet', disabled: r.page >= r.pages, onclick: (() => void load(r.page + 1).then(top)) as EventListener }, 'Older ›'))
        : '');
    }
  }
  const box = h('section', { class: 'comments' },
    h('h2', { class: 'visually-hidden' }, 'Comments'),
    o.canComment
      ? composer(o.placeholder, PROFILE.commentMax, 'Comment', async (body) => {
          await api(o.url, { body: { body } });
          await load(1);
        })
      : null,
    list, footer);
  const top = () => box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  void load(1).catch((e) => toast((e as Error).message, true));
  return box;
}
