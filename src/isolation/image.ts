/** A local image ID is usable only after the protected owned-build manifest has been verified. */
export function isImagePin(value: unknown): value is string {
  return typeof value === 'string' && (/^sha256:[a-f0-9]{64}$/.test(value) || /^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(value));
}
export function imageMatches(pin: string, image: {Id?: unknown; RepoDigests?: unknown} | undefined): boolean {
  if (!isImagePin(pin) || !image) return false;
  return pin.startsWith('sha256:') ? image.Id === pin : Array.isArray(image.RepoDigests) && image.RepoDigests.includes(pin);
}
