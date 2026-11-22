// In-app password prompt for protected PDF/HWP files (replaces window.prompt,
// which shows the browser's own dialog and the password in plain text).
// ask({ name, retry }) resolves to the password, or null when cancelled.
export function createPasswordDialog(doc = document) {
  const dialog = doc.getElementById("password-dialog");
  const form = doc.getElementById("password-form");
  const description = doc.getElementById("password-description");
  const input = doc.getElementById("password-input");
  const error = doc.getElementById("password-error");
  const cancel = doc.getElementById("password-cancel");
  const submit = doc.getElementById("password-submit");
  let pending = null;

  const finish = value => {
    if (!pending) return;
    const { resolve, opener } = pending;
    pending = null;
    input.value = "";
    if (dialog.open) dialog.close();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    resolve(value);
  };

  input.addEventListener("input", () => { submit.disabled = !input.value; });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (input.value) finish(input.value);
  });
  cancel.addEventListener("click", () => finish(null));
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    finish(null);
  });
  dialog.addEventListener("close", () => { if (!dialog.open) finish(null); });

  return ({ name, retry = false }) => {
    if (pending) return Promise.resolve(null);
    description.textContent = `${name} 파일을 열려면 비밀번호를 입력해 주세요.`;
    error.hidden = !retry;
    input.setAttribute("aria-invalid", String(retry));
    input.value = "";
    submit.disabled = true;
    return new Promise(resolve => {
      pending = { resolve, opener: doc.activeElement };
      dialog.showModal();
      input.focus({ preventScroll: true });
    });
  };
}
