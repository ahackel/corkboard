// Saves a Blob via a programmatic <a download> click.
const REVOKE_AFTER_MS = 4000;   // time for the download to start reading the URL

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), REVOKE_AFTER_MS);
}
