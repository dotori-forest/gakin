// Modal confirmation dialog with a tone option (default or danger).
export function createConfirmationDialog(doc = document) {
  const dialog = doc.getElementById("confirmation-dialog");
  const title = doc.getElementById("confirmation-title");
  const description = doc.getElementById("confirmation-description");
  const note = doc.getElementById("confirmation-note");
  const cancel = doc.getElementById("confirmation-cancel");
  const confirm = doc.getElementById("confirmation-confirm");
  let pending = null;
  let backdropPointerId = null;

  const finish = accepted => {
    if (!pending) return;
    const { resolve, opener } = pending;
    pending = null;
    backdropPointerId = null;
    if (dialog.open) dialog.close();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    resolve(accepted);
  };
  const isBackdrop = event => {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };

  cancel.addEventListener("click", () => finish(false));
  confirm.addEventListener("click", () => finish(true));
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    if (event.shiftKey && doc.activeElement === cancel) {
      event.preventDefault();
      confirm.focus();
    } else if (!event.shiftKey && doc.activeElement === confirm) {
      event.preventDefault();
      cancel.focus();
    }
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    finish(false);
  });
  dialog.addEventListener("close", () => { if (!dialog.open) finish(false); });
  dialog.addEventListener("pointerdown", event => {
    backdropPointerId = isBackdrop(event) ? event.pointerId : null;
  });
  dialog.addEventListener("pointerup", event => {
    const cancelFromBackdrop = backdropPointerId !== null
      && backdropPointerId === event.pointerId && isBackdrop(event);
    backdropPointerId = null;
    if (cancelFromBackdrop) finish(false);
  });
  dialog.addEventListener("pointercancel", () => { backdropPointerId = null; });

  return ({ title: heading, description: copy, note: extra = "", confirmLabel, tone = "default" }) => {
    if (pending) return Promise.resolve(false);
    title.textContent = heading;
    description.textContent = copy;
    note.textContent = extra;
    note.hidden = !extra;
    confirm.textContent = confirmLabel;
    dialog.dataset.tone = tone;
    return new Promise(resolve => {
      pending = { resolve, opener: doc.activeElement };
      dialog.showModal();
      cancel.focus({ preventScroll: true });
    });
  };
}
