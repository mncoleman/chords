// The app's own confirm and alert. The browser's are grey boxes headed by the
// site's address ("chords.mncoleman.com says"), styled by the operating
// system, and they freeze the page while open. These match the app and are
// awaited instead.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Options {
  title?: string;
  ok?: string;
  cancel?: string | null;
  /** The OK button does something that cannot be undone. */
  danger?: boolean;
}

function open(message: string, o: Options): Promise<boolean> {
  document.getElementById('app-dialog')?.remove();
  const back = document.createElement('div');
  back.id = 'app-dialog';
  back.className = 'dlg-back';
  back.innerHTML = `
    <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-msg">
      ${o.title ? `<strong id="dlg-title" class="dlg-title">${esc(o.title)}</strong>` : ''}
      <p id="dlg-msg" class="dlg-msg">${esc(message)}</p>
      <div class="dlg-acts">
        ${o.cancel === null ? '' : `<button class="dlg-cancel">${esc(o.cancel ?? 'Cancel')}</button>`}
        <button class="dlg-ok${o.danger ? ' danger' : ''}">${esc(o.ok ?? 'OK')}</button>
      </div>
    </div>`;
  if (!o.title) back.querySelector('.dlg')!.setAttribute('aria-labelledby', 'dlg-msg');
  const before = document.activeElement as HTMLElement | null;
  document.body.appendChild(back);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      back.remove();
      document.removeEventListener('keydown', key, true);
      before?.focus?.();
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener('keydown', key, true);
    back.querySelector('.dlg-ok')!.addEventListener('click', () => done(true));
    back.querySelector('.dlg-cancel')?.addEventListener('click', () => done(false));
    // A tap outside is a "no", never a "yes".
    back.addEventListener('click', (e) => {
      if (e.target === back) done(false);
    });
    // A destructive OK is not the default; the safe answer gets the focus.
    (back.querySelector<HTMLElement>(o.danger ? '.dlg-cancel' : '.dlg-ok') ?? back.querySelector<HTMLElement>('.dlg-ok'))!.focus();
  });
}

export const confirmBox = (message: string, o: Options = {}) => open(message, o);
export const alertBox = (message: string, o: Omit<Options, 'cancel'> = {}) =>
  open(message, { ...o, cancel: null }).then(() => undefined);
