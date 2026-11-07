// Special characters in legacy URLs: one page, two spellings on the wire.
//
// A slug that ends in "?" is sent by a browser without the "?" (it starts an empty query), while a
// correctly encoded link sends "%3F". A "#" never reaches the server at all; only "%23" does.
// Visitors and search engines arrive with both spellings, so both are probed.

const encodedQ = /%3F/gi;

/** The other spellings of a source path that a real visitor can send. Empty when there is none. */
export function otherSpellings(from) {
  if (!from || /^https?:\/\//i.test(from)) return [];
  const out = new Set();
  const [beforeHash, ...afterHash] = from.split('#');
  const hash = afterHash.length ? afterHash.join('#') : null;
  if (hash !== null) out.add(beforeHash + '%23' + hash.replace(/#/g, '%23')); // only the encoded form can be redirected
  const q = beforeHash.indexOf('?');
  // A "?" with nothing after it is part of the slug, not a query string.
  if (q > -1 && beforeHash.slice(q + 1) === '') out.add(beforeHash.slice(0, q) + '%3F');
  if (encodedQ.test(beforeHash)) out.add(beforeHash.replace(encodedQ, '?'));
  encodedQ.lastIndex = 0;
  out.delete(from);
  return [...out];
}

/** Add one probe row per other spelling, unless the map already has that spelling as its own rule. */
export function withOtherSpellings(rules) {
  const have = new Set(rules.map(r => r.from));
  const extra = [];
  for (const r of rules) {
    for (const s of otherSpellings(r.from)) {
      if (have.has(s)) continue;
      have.add(s);
      extra.push({ ...r, from: s, variantOf: r.from, note: `other spelling of ${r.from}` });
    }
  }
  return [...rules, ...extra];
}
