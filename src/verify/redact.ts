/** Masking of credentials in text that goes into messages and logs. */

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

/** Replace the `user:password@` part of every URL in `text` with `***@`. */
export function redactUrls(text: string): string {
  return text.replace(URL_USERINFO, "$1***@");
}
