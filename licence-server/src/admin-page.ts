/**
 * The owner's admin page: licences, their PCs, payments and support. One page, no outside files;
 * every value from the database goes in as text, never as HTML.
 */
export const adminPage = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تراخيص Manager+</title>
<style>
:root { --bg: #f6f7f5; --card: #fff; --text: #1f2a26; --muted: #66736d; --accent: #2f6f5e; --soft: #e8f0ec; --warn: #a1452b; --line: #dde3df; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Tahoma, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); font-size: 15px; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 17px; margin: 0 0 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
form.row, .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input { font: inherit; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--card); color: var(--accent); cursor: pointer; }
button.primary { background: var(--accent); color: #fff; }
button.danger { border-color: var(--warn); color: var(--warn); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: start; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--muted); font-weight: normal; }
.muted { color: var(--muted); font-size: 13px; }
.ltr { direction: ltr; unicode-bidi: isolate; white-space: nowrap; }
.badge { white-space: nowrap; display: inline-block; padding: 1px 8px; border-radius: 10px; background: var(--soft); font-size: 12px; }
.badge.warn { background: #f6e3dc; color: var(--warn); }
.key { font-family: Consolas, monospace; font-size: 20px; background: var(--soft); padding: 10px 14px; border-radius: 8px; direction: ltr; display: inline-block; }
.message { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; background: var(--soft); }
.message.error { background: #f6e3dc; color: var(--warn); }
details { margin-top: 6px; }
@media (max-width: 700px) { .hide-small { display: none; } }
</style></head><body><main>
<h1>تراخيص Manager+</h1>
<div id="message" hidden></div>
<section class="card">
  <h2>ترخيص جديد</h2>
  <form id="create" class="row">
    <label>الشركة <input name="company" required></label>
    <label>عدد المستخدمين <input name="users" type="number" min="1" max="1000" value="1" required style="width:90px"></label>
    <label>الدعم لحد <input name="supportUntil" type="date" required></label>
    <label>ملاحظات <input name="notes"></label>
    <button class="primary">إنشاء المفتاح</button>
  </form>
  <p id="newKey" hidden></p>
</section>
<section class="card">
  <h2>نشر تحديث</h2>
  <p class="muted">الصق هنا اللي طبعه <span class="ltr">node scripts/release.mjs sign …</span>. البرنامج بيتأكد من التوقيع بنفسه، فالخادم مايقدرش يزوّر تحديث.</p>
  <form id="release" class="row">
    <label style="flex:1">الـ manifest الموقّع <textarea name="signed" rows="3" required class="ltr" style="width:100%;font:13px Consolas,monospace;white-space:pre-wrap"></textarea></label>
    <button class="primary">نشر</button>
  </form>
  <ul id="releases" class="muted"></ul>
</section>
<section class="card">
  <h2>التراخيص</h2>
  <table><thead><tr><th>الشركة</th><th>المفتاح</th><th>المستخدمين</th><th>الدعم لحد</th><th class="hide-small">الجهاز</th><th>النقل</th><th class="hide-small">المدفوع</th><th></th></tr></thead>
  <tbody id="rows"></tbody></table>
</section>
<script>
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const pounds = (p) => (p / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2 });
function say(text, error = false) { const m = $("#message"); m.hidden = false; m.className = error ? "message error" : "message"; m.textContent = text; }
const ERRORS = { invalid_input: "البيانات ناقصة أو غلط.", not_found: "الترخيص مش موجود.", server_error: "حصل خطأ في الخادم." };
async function api(path, body) {
  const r = await fetch("/admin/api" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(ERRORS[data.error] || data.error || r.status);
  return data;
}
function showKey(company, key) {
  const p = $("#newKey"); p.hidden = false; p.replaceChildren(el("span", { textContent: "مفتاح " + company + " (بيظهر مرة واحدة بس، انسخه دلوقتي): " }), el("br"), el("span", { className: "key", textContent: key }));
}
async function act(work, done) { try { await work(); say(done); await load(); } catch (e) { say(e.message, true); } }
function actions(l) {
  const box = el("details", {}, el("summary", { textContent: "إجراءات" }));
  const pay = el("form", { className: "row" },
    el("label", {}, "تاريخ الدفع", el("input", { name: "paidOn", type: "date", required: true, value: new Date().toISOString().slice(0, 10) })),
    el("label", {}, "المبلغ (جنيه)", el("input", { name: "amount", type: "number", min: "0.01", step: "0.01", required: true, style: "width:110px" })),
    el("label", {}, "ملاحظة", el("input", { name: "note" })),
    el("button", { textContent: "تسجيل دفعة" }));
  pay.onsubmit = (e) => { e.preventDefault(); const f = new FormData(pay); act(() => api("/licences/" + l.id + "/payments", { paidOn: f.get("paidOn"), amount: Math.round(Number(f.get("amount")) * 100), note: f.get("note") }), "اتسجلت الدفعة."); };
  const edit = el("form", { className: "row" },
    el("label", {}, "الدعم لحد", el("input", { name: "supportUntil", type: "date", value: l.supportUntil })),
    el("label", {}, "المستخدمين", el("input", { name: "users", type: "number", min: "1", max: "1000", value: l.users, style: "width:90px" })),
    el("button", { textContent: "حفظ" }));
  edit.onsubmit = (e) => { e.preventDefault(); const f = new FormData(edit); act(() => api("/licences/" + l.id + "/update", { supportUntil: f.get("supportUntil"), users: Number(f.get("users")) }), "اتحفظ. العميل يفعّل تاني عشان ياخد الملف الجديد."); };
  const reset = el("button", { type: "button", textContent: "مسح التفعيلات" });
  reset.onclick = () => confirm("مسح تفعيل " + l.company + "؟ العميل هيقدر يفعّل على أي جهاز.") && act(() => api("/licences/" + l.id + "/reset", {}), "اتمسحت التفعيلات.");
  const rekey = el("button", { type: "button", textContent: "مفتاح جديد" });
  rekey.onclick = () => confirm("المفتاح القديم هيبطل. متأكد؟") && act(async () => showKey(l.company, (await api("/licences/" + l.id + "/new-key", {})).key), "اتعمل مفتاح جديد.");
  const revoke = el("button", { type: "button", className: "danger", textContent: "إلغاء الترخيص" });
  revoke.onclick = () => confirm("إلغاء ترخيص " + l.company + " نهائيًا؟") && act(() => api("/licences/" + l.id + "/revoke", {}), "اتلغى الترخيص.");
  const history = el("ul", { className: "muted" }, ...l.activations.map((a) => el("li", { textContent: a.activatedAt.slice(0, 10) + " · " + a.machine.slice(0, 12) + (a.endedAt ? " · انتهى " + a.endedAt.slice(0, 10) + " (" + a.endReason + ")" : " · الحالي") + (a.appVersion ? " · " + a.appVersion : "") })),
    ...l.payments.map((p) => el("li", { textContent: "دفعة " + p.paidOn + " · " + pounds(p.amount) + (p.note ? " · " + p.note : "") })));
  if (!l.revokedAt) box.append(pay, edit, el("div", { className: "row" }, reset, rekey, revoke));
  box.append(history);
  return box;
}
async function load() {
  const releases = await api("/releases");
  $("#releases").replaceChildren(...releases.map((r) => el("li", { textContent: "الإصدار " + r.version + " · اتنشر " + r.publishedAt.slice(0, 10) })));
  const licences = await api("/licences");
  $("#rows").replaceChildren(...licences.map((l) => el("tr", {},
    el("td", {}, el("strong", { textContent: l.company }), l.notes ? el("div", { className: "muted", textContent: l.notes }) : "", l.revokedAt ? el("span", { className: "badge warn", textContent: "ملغي" }) : "", actions(l)),
    el("td", { className: "ltr", textContent: "…" + l.keyHint }),
    el("td", { textContent: l.users }),
    el("td", {}, el("span", { className: l.supportUntil < new Date().toISOString().slice(0, 10) ? "badge warn" : "badge", textContent: l.supportUntil })),
    el("td", { className: "ltr hide-small", textContent: l.machine ? l.machine.slice(0, 12) + "…" : "—" }),
    el("td", { className: "ltr", textContent: l.movesUsed + " / 2" }),
    el("td", { className: "hide-small", textContent: pounds(l.paid) }),
    el("td", {}))));
}
$("#create").onsubmit = (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  act(async () => { const r = await api("/licences", { company: f.get("company"), users: Number(f.get("users")), supportUntil: f.get("supportUntil"), notes: f.get("notes") }); showKey(f.get("company"), r.key); e.target.reset(); }, "اتعمل الترخيص.");
};
$("#release").onsubmit = (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  act(async () => { let signed; try { signed = JSON.parse(String(f.get("signed"))); } catch { throw new Error("النص مش JSON سليم."); } const r = await api("/releases", signed); e.target.reset(); say("اتنشر الإصدار " + r.version + "."); }, "اتنشر.");
};
const nextYear = new Date(); nextYear.setFullYear(nextYear.getFullYear() + 1); $("#create [name=supportUntil]").value = nextYear.toISOString().slice(0, 10);
load().catch((e) => say(e.message, true));
</script>
</main></body></html>`;
