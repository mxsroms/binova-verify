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
  document.body.dataset.state = state;
  $("title").textContent = title;
  $("message").textContent = message;
  if ($("entry-panel")) $("entry-panel").hidden = state !== "empty" && state !== "failed";
  if ($("new-verification")) $("new-verification").hidden = state === "empty";
}
function field(key, label, value) {
  const group = node("div");
  group.dataset.field = key;
  const dd = node("dd");
  dd.append(cell(value));
  group.append(node("dt", label), dd);
  $("fields").append(group);
}

function showQuantity(snapshot) {
  const field = $("summary-quantity-field");
  if (!field) return;
  field.hidden = true;
  $("summary-quantity").replaceChildren();
  const production = snapshot.type === "PRODUCTION", count = snapshot.type === "ADJUSTMENT";
  const lines = production ? snapshot.outputs : snapshot.lines;
  if (!lines.length) return;
  const totals = new Map();
  for (const line of lines) {
    const value = count ? line.countedQuantity : line.quantity;
    if (!line.unit || !Number.isFinite(value) || value < 0) return;
    // BINOVA stock quantities have three decimal places. Sum per unit in thousandths.
    const sum = (totals.get(line.unit) ?? 0) + Math.round(value * 1000);
    if (!Number.isSafeInteger(sum)) return;
    totals.set(line.unit, sum);
  }
  if ($("summary-quantity-label"))
    $("summary-quantity-label").textContent = production ? "إجمالي الناتج" : count ? "إجمالي المعدود" : "الكمية الإجمالية";
  for (const [unit, value] of totals) {
    if ($("summary-quantity").childElementCount) $("summary-quantity").append(" + ");
    $("summary-quantity").append(cell(value / 1000 + " " + unit));
  }
  field.hidden = false;
}

function renderSummary(result, state, published) {
  const cancelled = state.s === "CANCELLED";
  const when = formatter.format(new Date(state.a)) + " (UTC)";
  verdict(cancelled ? "cancelled" : "valid",
    cancelled ? "إذن أصلي · ملغى" : "ختم رقمي صحيح",
    result.demo ? "وقّعت جهة التجربة المسجّلة بيانات هذا الإذن." : "طابق التوقيع الرقمي المفتاح العام للجهة المصدرة.");
  $("fields").replaceChildren();
  const type = result.payload.t;
  const typeTitle = type === "ISSUE" && result.payload.dn === true ? "إذن تسليم" : (types.get(type) || type);
  if ($("summary-strip")) {
    $("summary-number").textContent = result.payload.n;
    $("summary-type").textContent = typeTitle;
    $("summary-strip").hidden = false;
  } else {
    field("number", "رقم الإذن", result.payload.n);
    field("type", "نوع الإذن", typeTitle);
  }
  field("date", "تاريخ الإذن", result.payload.d);
  field("issuer", "الجهة المصدرة", result.issuer);
  if (result.payload.j) field("job", "أمر الشغل", result.payload.j);
  field("status", "الحالة وقت التوقيع", cancelled ? "ملغى" : "مرحّل");
  field("signed", published ? "آخر تحديث منشور وموقّع" : "وقت توقيع الحالة في الرمز", when);
  $("status-note").textContent = cancelled
    ? "سجّل المصنع إلغاء هذا الإذن. طابق رقمه وبياناته مع النسخة الورقية."
    : "الحالة المعروضة مؤرخة. قد يسجّل المصنع إلغاءً لاحقًا؛ استخدم آخر نسخة منشورة أو راجع المصنع لتأكيد الحالة الحالية.";
  $("verified").hidden = false;
}
function table(title, columns, rows) {
  if (!rows.length) return;
  const section = node("section"), heading = node("h3", title), container = node("div"), table = node("table");
  section.className = "detail-group";
  container.className = "table-wrap"; container.tabIndex = 0;
  container.setAttribute("role", "region"); container.setAttribute("aria-label", title);
  const visible = columns.filter(col => !col.optional || rows.some(row => row[col.key] != null && row[col.key] !== ""));
  const header = table.createTHead().insertRow();
  for (const col of visible) { const th = node("th", col.label); th.scope = "col"; header.append(th); }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const col of visible) {
      const td = tr.insertCell();
      td.dataset.column = col.key;
      td.dataset.label = col.label;
      const value = row[col.key];
      if (value == null || value === "") td.dataset.empty = "true";
      td.append(cell(value === "" || value == null ? "—" : value));
      if (col.key === "item" && row.itemCode) {
        const code = node("small");
        code.className = "item-code";
        code.append(cell(row.itemCode));
        td.append(code);
      }
    }
  }
  container.append(table);
  section.append(heading, container);
  $("details").append(section);
}
function renderDetails(snapshot) {
  const details = $("details"); details.replaceChildren(); details.hidden = false;
  showQuantity(snapshot);
  if (snapshot.reference) {
    const reference = node("section");
    reference.className = "detail-group reference";
    reference.append(node("h3", "المرجع"), cell(snapshot.reference));
    details.append(reference);
  }
  function lines(title, items) {
    const adjustment = snapshot.type === "ADJUSTMENT";
    const columns = [
      { key:"item", label:"الصنف" }, { key:"batch", label:"التشغيلة", optional:true },
      { key:"reel", label:"البكرة", optional:true }, { key:"pallet", label:"البالتة", optional:true },
      { key:"location", label:"الموقع", optional:true },
      ...(adjustment ? [{key:"expected", label:"الرصيد وقت الجرد"}] : []),
      { key:"quantity", label:adjustment ? "الكمية المعدودة" : "الكمية" },
    ];
    const rows = items.map(x => ({
      item:x.itemName, itemCode:x.itemCode, batch:x.batch, reel:x.reel, pallet:x.pallet,
      location:[x.locationName,x.toLocationName].filter(Boolean).join(" ← "),
      expected:x.expectedQuantity == null ? null : x.expectedQuantity + " " + x.unit,
      quantity:adjustment ? (x.countedQuantity == null ? null : x.countedQuantity + " " + x.unit) : x.quantity + " " + x.unit,
    }));
    table(title, columns, rows);
  }
  lines("بنود الحركة", snapshot.lines);
  lines("الخامات المستهلكة", snapshot.inputs);
  lines("الناتج", snapshot.outputs);
  table("توزيع الخامة على البالتات", [
    {key:"reel", label:"البكرة"}, {key:"pallet", label:"بالتة الناتج"}, {key:"quantity", label:"كمية الخامة"},
  ],
    snapshot.allocations.map(row => {
      const input = snapshot.inputs[row.inputIndex], output = snapshot.outputs[row.outputIndex];
      return {reel:input.reel, pallet:output.pallet, quantity:row.quantity + " " + input.unit};
    }));
  details.hidden = !details.childElementCount;
}
let requestId = 0;
async function start() {
  const fragment = location.hash, id = ++requestId;
  const current = () => id === requestId && location.hash === fragment;
  $("verified").hidden = $("details").hidden = true;
  if ($("summary-strip")) {
    $("summary-strip").hidden = true;
    $("summary-number").textContent = $("summary-type").textContent = "";
    $("summary-quantity-field").hidden = true;
    $("summary-quantity").replaceChildren();
  }
  if ($("verify-input")) {
    $("verify-input").removeAttribute("aria-invalid");
    $("input-message").textContent = "";
  }
  $("fields").replaceChildren(); $("details").replaceChildren();
  $("lookup-result").textContent = ""; $("lookup").disabled = false; $("lookup").onclick = null;
  if (!fragment) {
    verdict("empty", "التحقق من إذن", "امسح رمز QR المطبوع على الإذن أو الصق رابط التحقق أدناه.");
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
    if ($("verify-input")) $("verify-input").value = "";
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

function pastedFragment(value) {
  const text = value.trim();
  if (!text || text.length > 8700) return null;
  let token;
  if (text.startsWith("b2.")) {
    token = text;
  } else if (text.startsWith("#v=")) {
    token = text.slice(3);
  } else {
    let url;
    try { url = new URL(text); } catch { return null; }
    const path = url.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "");
    const here = location.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "");
    const samePage = url.origin === location.origin && path === here;
    const publicPage = url.origin === "https://mxsroms.github.io" && path === "/binova-verify/v2";
    if ((!samePage && !publicPage) || !["http:", "https:"].includes(url.protocol) ||
        url.username || url.password || url.search || !url.hash.startsWith("#v=")) return null;
    token = url.hash.slice(3);
  }
  return token.length <= 8192 && /^b2\.[\w-]+\.[\w-]+(?:\.[\w-]+)?$/.test(token) ? "#v=" + token : null;
}

$("verify-form")?.addEventListener("submit", event => {
  event.preventDefault();
  const input = $("verify-input"), fragment = pastedFragment(input.value);
  if (!fragment) {
    $("input-message").textContent = "الصق رابط التحقق من BINOVA أو رمز الختم الكامل.";
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  // Process the fragment here. Pasted input never triggers navigation to a supplied URL.
  $("title").tabIndex = -1;
  $("title").focus({preventScroll:true});
  window.scrollTo({top:0, behavior:"instant"});
  if (fragment === location.hash) start();
  else location.hash = fragment;
});
window.addEventListener("hashchange", start);
start();
