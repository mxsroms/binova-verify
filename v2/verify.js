const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const SNAPSHOT_LIMIT = 1024 * 1024;
const authorities = {
  b2: "BINOVA:public-voucher:v2\n",
  s2: "BINOVA:public-status:v2\n",
};
export class VerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code = "invalid") { throw new VerificationError(code); }

function toBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decode(s, maxChars) {
  if (typeof s !== "string" || s.length > maxChars || !/^[\w-]+$/.test(s)) fail();
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (toBase64url(bytes) !== s) fail();
  return bytes;
}
async function digest(bytes) {
  return toBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d\d-\d\d$/.test(s)) return false;
  const date = new Date(s + "T00:00:00.000Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === s;
}
function validTime(s) {
  if (typeof s !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)) return false;
  const date = new Date(s);
  return Number.isFinite(date.valueOf()) && date.toISOString() === s;
}
function readPayload(encoded) {
  const doc = JSON.parse(decoder.decode(decode(encoded, 5500)));
  if (!doc || typeof doc !== "object" || Array.isArray(doc) ||
      !/^[A-Za-z0-9_-]{16}$/.test(doc.k) || !/^[A-Za-z0-9_-]{43}$/.test(doc.h) ||
      !["POSTED", "CANCELLED"].includes(doc.s) || !validTime(doc.a)) fail();
  return doc;
}
async function checkSigned(prefix, encoded, signature, registry) {
  if (!globalThis.crypto?.subtle) fail("unsupported");
  const payload = readPayload(encoded);
  if (registry?.version !== 1 || !Array.isArray(registry.keys)) fail("registry");
  const matches = registry.keys.filter(key => key?.kid === payload.k);
  if (!matches.length) fail("unknown");
  const entry = matches[0];
  if (matches.length !== 1 || typeof entry.issuer !== "string" || !entry.issuer.trim() || entry.issuer.length > 120) fail("registry");
  const der = decode(entry.publicKey, 150);
  if ((await digest(der)).slice(0, 16) !== payload.k) fail("registry");
  let key;
  try { key = await crypto.subtle.importKey("spki", der, "Ed25519", false, ["verify"]); }
  catch (err) { fail(err.name === "NotSupportedError" ? "unsupported" : "registry"); }
  const rawSignature = decode(signature, 86);
  if (rawSignature.length !== 64 ||
      !(await crypto.subtle.verify("Ed25519", key, rawSignature, utf8.encode(authorities[prefix] + encoded)))) fail();
  return { payload, issuer: entry.issuer, demo: entry.demo === true };
}
export async function readLimited(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); fail(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function validLine(line) {
  return line && typeof line.itemName === "string" && typeof line.unit === "string" &&
    typeof line.quantity === "number" && Number.isFinite(line.quantity) && line.quantity >= 0;
}
async function checkSnapshot(payload, raw) {
  if (typeof raw !== "string" || raw.length > SNAPSHOT_LIMIT) fail();
  const bytes = utf8.encode(raw);
  if (bytes.length > SNAPSHOT_LIMIT || await digest(bytes) !== payload.h) fail();
  const snapshot = JSON.parse(raw);
  if (!snapshot || snapshot.number !== payload.n || snapshot.date !== payload.d ||
      snapshot.type !== payload.t || (snapshot.jobReference || "") !== (payload.j || "") ||
      ![snapshot.inputs, snapshot.outputs, snapshot.lines].every(group => Array.isArray(group) && group.every(validLine)) ||
      !Array.isArray(snapshot.allocations) || !snapshot.allocations.every(row =>
        row && Number.isInteger(row.inputIndex) && !!snapshot.inputs[row.inputIndex] &&
        Number.isInteger(row.outputIndex) && !!snapshot.outputs[row.outputIndex] &&
        typeof row.quantity === "number" && Number.isFinite(row.quantity) && row.quantity > 0)) fail();
  return snapshot;
}
export async function verifyToken(token, registry) {
  if (typeof token !== "string" || token.length > 8192) fail();
  const [prefix, data, signature, compressed, ...extra] = token.split(".");
  if (prefix !== "b2" || extra.length || !signature) fail();
  const result = await checkSigned(prefix, data, signature, registry);
  const p = result.payload;
  if (!/^(PRD|MOV)-\d{7,}$/.test(p.n) || !validDate(p.d) || !/^[A-Z][A-Z_]{0,39}$/.test(p.t) ||
      (p.j !== undefined && (typeof p.j !== "string" || p.j.length > 100))) fail();
  if (compressed === undefined) return result;
  try {
    const bytes = decode(compressed, 4096);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const raw = decoder.decode(await readLimited(stream, SNAPSHOT_LIMIT));
    result.snapshot = await checkSnapshot(p, raw);
  } catch {
    // Keep the independently signed summary. Never display unverified details.
    result.detailsUnavailable = true;
  }
  return result;
}
export async function verifyPublished(record, summary, registry) {
  if (typeof record?.statusToken !== "string" || record.statusToken.length > 6000) fail();
  const [prefix, data, signature, ...extra] = record.statusToken.split(".");
  if (prefix !== "s2" || extra.length || !signature) fail();
  const { payload } = await checkSigned(prefix, data, signature, registry);
  if (payload.k !== summary.k || payload.h !== summary.h) fail();
  const snapshot = await checkSnapshot(summary, record.snapshot);
  return { payload, snapshot };
}
