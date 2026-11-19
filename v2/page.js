import { verifyToken, verifyPublished, readLimited, SNAPSHOT_LIMIT } from "./verify.js";

const $ = id => document.getElementById(id);
const types = new Map(Object.entries({
  PRODUCTION: "إذن إنتاج", RECEIPT: "إذن استلام", ISSUE: "إذن صرف", TRANSFER: "إذن تحويل",
  OPENING: "رصيد افتتاحي", ADJUSTMENT: "تسوية مخزون", DAMAGE: "تالف", RETURN: "مرتجع عميل",
  HOLD: "حجز جودة", RELEASE: "إفراج جودة",
}));
const formatter = new Intl.DateTimeFormat("ar-EG", {
  dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
});
function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function cell(value) { return node("bdi", value); }
function verdict(state, title, message) {
  $("verdict").dataset.state = state;
  $("title").textContent = title;
  $("message").textContent = message;
}
function field(label, value) {
  const group = node("div");
  const dd = node("dd");
  dd.append(cell(value));
  group.append(node("dt", label), dd);
  $("fields").append(group);
}
function renderSummary(result, state, published) {
  const cancelled = state.s === "CANCELLED";
  const when = formatter.format(new Date(state.a)) + " (UTC)";
  verdict(cancelled ? "cancelled" : "valid",
    cancelled ? "إذن أصلي · ملغى" : "ختم رقمي صحيح",
    result.demo ? "وقّعت جهة التجربة المسجّلة بيانات هذا الإذن." : "طابق التوقيع الرقمي المفتاح العام للجهة المصدرة.");
  $("fields").replaceChildren();
  field("الجهة المصدرة", result.issuer);
  field("رقم الإذن", result.payload.n);
  field("نوع الإذن", types.get(result.payload.t) || result.payload.t);
  field("تاريخ الإذن", result.payload.d);
  if (result.payload.j) field("أمر الشغل", result.payload.j);
  field("الحالة وقت التوقيع", cancelled ? "ملغى" : "مرحّل");
  field(published ? "آخر تحديث منشور وموقّع" : "وقت توقيع الحالة في الرمز", when);
  $("status-note").textContent = cancelled
    ? "سجّل المصنع إلغاء هذا الإذن. طابق رقمه وبياناته مع النسخة الورقية."
    : "الحالة المعروضة مؤرخة. قد يسجّل المصنع إلغاءً لاحقًا؛ استخدم آخر نسخة منشورة أو راجع المصنع لتأكيد الحالة الحالية.";
  $("verified").hidden = false;
}
function table(title, headers, rows) {
  if (!rows.length) return;
  const heading = node("h2", title), container = node("div"), table = node("table");
  container.className = "table-wrap"; container.tabIndex = 0;
  container.setAttribute("role", "region"); container.setAttribute("aria-label", title);
  const header = table.createTHead().insertRow();
  for (const h of headers) { const th = node("th", h); th.scope = "col"; header.append(th); }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) tr.insertCell().append(cell(value || "—"));
  }
  container.append(table);
  $("details").append(heading, container);
}
function renderDetails(snapshot) {
  const details = $("details"); details.replaceChildren(); details.hidden = false;
  if (snapshot.reference) details.append(node("h2", "المرجع"), cell(snapshot.reference));
  function lines(title, items) {
    const adjustment = snapshot.type === "ADJUSTMENT";
    const headers = ["الصنف", "الموقع", "التشغيلة", "البكرة", "البالتة",
      ...(adjustment ? ["الرصيد وقت الجرد", "الكمية المعدودة"] : ["الكمية"])];
    const rows = items.map(x => [x.itemName + (x.itemCode ? " · " + x.itemCode : ""),
      x.locationName + (x.toLocationName ? " ← " + x.toLocationName : ""),
      x.batch, x.reel, x.pallet, ...(adjustment
        ? [x.expectedQuantity, x.countedQuantity].map(q => q == null ? "—" : q + " " + x.unit)
        : [x.quantity + " " + x.unit])]);
    table(title, headers, rows);
  }
  lines("بنود الحركة", snapshot.lines);
  lines("الخامات المستهلكة", snapshot.inputs);
  lines("الناتج", snapshot.outputs);
  table("توزيع الخامة على البالتات", ["البكرة", "بالتة الناتج", "كمية الخامة"],
    snapshot.allocations.map(row => {
      const input = snapshot.inputs[row.inputIndex], output = snapshot.outputs[row.outputIndex];
      return [input.reel, output.pallet, row.quantity + " " + input.unit];
    }));
}
let requestId = 0;
async function start() {
  const id = ++requestId, current = () => id === requestId;
  $("verified").hidden = $("details").hidden = true;
  $("fields").replaceChildren(); $("details").replaceChildren();
  $("lookup-result").textContent = ""; $("lookup").disabled = false; $("lookup").onclick = null;
  const fragment = location.hash;
  if (!fragment) {
    verdict("empty", "التحقق من إذن", "امسح رمز QR المطبوع على إذن BINOVA لعرض بياناته والتحقق من توقيع الجهة المصدرة.");
    return;
  }
  verdict("checking", "جارٍ التحقق من الختم…", "");
  try {
    if (!fragment.startsWith("#v=")) throw new Error();
    let registry;
    try {
      const response = await fetch("./keys.json", {cache: "no-store", credentials: "omit", redirect:"error"});
      if (!response.ok) throw new Error();
      registry = await response.json();
    } catch { throw Object.assign(new Error(), {code: "registry"}); }
    const result = await verifyToken(fragment.slice(3), registry);
    if (!current()) return;
    renderSummary(result, result.payload, false);
    if (result.snapshot) renderDetails(result.snapshot);
    else $("lookup-result").textContent = result.detailsUnavailable
      ? "تم التحقق من ملخص الإذن فقط. تعذّرت قراءة التفاصيل المرفقة بهذا الرمز."
      : "يحمل الرمز ملخص الإذن. يمكن عرض البنود إذا نشر المصنع نسخة التفاصيل.";
    let newest = result.payload;
    $("lookup").onclick = async () => {
      $("lookup").disabled = true; $("lookup-result").textContent = "جارٍ البحث عن نسخة موقّعة…";
      try {
        const response = await fetch("./records/" + result.payload.h + ".json", {cache:"no-store", credentials:"omit", redirect:"error"});
        if (response.status === 404) throw Object.assign(new Error(), {code:"absent"});
        if (!response.ok || !response.body) throw new Error();
        const raw = await readLimited(response.body, 2 * SNAPSHOT_LIMIT + 10000);
        const record = await verifyPublished(JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(raw)), result.payload, registry);
        if (!current()) return;
        renderDetails(record.snapshot);
        // A cancellation is final. Never replace it with an older published "posted" status.
        if (record.payload.a >= newest.a && !(newest.s === "CANCELLED" && record.payload.s === "POSTED")) {
          newest = record.payload; renderSummary(result, newest, true);
          $("lookup-result").textContent = "طابقت التفاصيل بصمة الإذن، وتم التحقق من توقيع الحالة المنشورة.";
        } else {
          $("lookup-result").textContent = "طابقت التفاصيل بصمة الإذن. أبقينا أحدث حالة موثّقة ظهرت لهذا الإذن.";
        }
      } catch (err) {
        if (current()) $("lookup-result").textContent = err.code === "absent"
          ? "لم ينشر المصنع ملفًا لهذا الإذن على الموقع."
          : "تعذّر التحقق من النسخة المنشورة. تبقى بيانات الختم الموثّقة معروضة أعلاه.";
      } finally { if (current()) $("lookup").disabled = false; }
    };
  } catch (err) {
    if (!current()) return;
    const messages = {
      registry: "تعذّر تحميل قائمة الجهات الموثوقة. أعد فتح الصفحة حين يتوفر الاتصال.",
      unknown: "مفتاح الجهة المصدرة غير مسجّل لدى موقع التحقق. راجع الجهة المصدرة.",
      unsupported: "افتح الرابط باستخدام HTTPS في متصفح حديث يدعم التحقق من توقيع Ed25519.",
    };
    verdict("failed", "تعذّر إثبات أصالة الإذن", messages[err.code] || "الرمز غير صالح أو لم يطابق التوقيع المفتاح المسجّل.");
  }
}
window.addEventListener("hashchange", start);
start();
