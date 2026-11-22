# خادم التراخيص (Cloudflare Workers + D1)

ده الخادم الصغير اللي البرنامج بيكلّمه مرة واحدة وقت التفعيل. بياخد مفتاح الترخيص وبصمة جهاز السيرفر، ويرجّع ملف ترخيص موقّع بمفتاح Ed25519. البرنامج بعد كده بيتأكد من الملف من غير نت في كل تشغيل.

وفيه صفحة إدارة بكلمة سر، منها تعمل مفاتيح، وتسجّل المدفوعات، وتمدّ الدعم، وتزوّد المستخدمين، وتمسح التفعيلات، وتلغي ترخيص.

## اللي محتاجه

- حساب Cloudflare. الخطة المجانية كفاية: Workers وD1 مجانيين للحجم ده.
- Node.js 20 أو أحدث على جهازك، ونسخة من الريبو.

## خطوات النشر (مرة واحدة)

كل الأوامر دي من فولدر الريبو.

1. سجّل الدخول لـ Cloudflare:
   ```
   npx wrangler login
   ```
2. اعمل قاعدة البيانات:
   ```
   npx wrangler d1 create manager-plus-licences
   ```
   هيطبع `database_id`. حطه مكان `REPLACE_WITH_DATABASE_ID` في `licence-server/wrangler.toml`.
3. اعمل الجداول:
   ```
   npx wrangler d1 execute manager-plus-licences --remote --file licence-server/schema.sql --config licence-server/wrangler.toml
   ```
4. اعمل مفتاح التوقيع. الأمر ده بيكتب المفتاح العام جوه البرنامج (`src/core/licence/public-key.ts`)، وبيبعت المفتاح الخاص على طول لـ Cloudflare كـ secret، فمش بيتحفظ على جهازك:
   ```
   node licence-server/make-keys.mjs | npx wrangler secret put LICENCE_PRIVATE_KEY --config licence-server/wrangler.toml
   ```
   اعمله **مرة واحدة بس**. لو اتعمل تاني، كل التراخيص اللي اتعملت قبل كده هتبطل.
   بعدها اعمل commit لملف `public-key.ts` (أو ابعتهولي وأنا أعمله).
5. حط كلمة سر صفحة الإدارة. اختار كلمة طويلة:
   ```
   npx wrangler secret put ADMIN_PASSWORD --config licence-server/wrangler.toml
   ```
6. انشر:
   ```
   npx wrangler deploy --config licence-server/wrangler.toml
   ```
   هيطبع العنوان، زي `https://manager-plus-licences.<اسمك>.workers.dev`.
7. (اختياري، ومستحسن) اربطه بدومين ليك، زي `licence.example.com`: من Cloudflare ← Workers ← manager-plus-licences ← Settings ← Domains & Routes.
8. ابعتلي العنوان النهائي عشان أحطه في البرنامج (`LICENCE_SERVER` في `src/main/licence.ts`).

## الاستخدام

- **صفحة الإدارة:** `https://<العنوان>/admin`. اسم المستخدم أي حاجة، وكلمة السر هي `ADMIN_PASSWORD`.
- **ترخيص جديد:** اكتب الشركة، وعدد المستخدمين، وتاريخ نهاية الدعم، واضغط "إنشاء المفتاح". المفتاح بيظهر **مرة واحدة بس**، فانسخه وابعته للعميل. الخادم مش بيحفظ المفتاح نفسه.
- **العميل ضاع منه المفتاح:** "مفتاح جديد". القديم بيبطل، والجهاز المفعّل بيفضل شغال.
- **تجديد الدعم أو زيادة المستخدمين:** عدّل من "إجراءات"، والعميل يفعّل تاني من الإعدادات عشان ياخد الملف الجديد.
- **النقل لجهاز تاني:** العميل يفعّل على الجهاز الجديد بنفس المفتاح، ودي بتتحسب نقلة. مسموح نقلتين في أي 12 شهر. لو خلصوا، "مسح التفعيلات" بيصفّر العدّاد.
- **إلغاء الترخيص:** المفتاح بيبطل يفعّل. الجهاز اللي معاه الملف بيفضل شغال لحد ما يحتاج يفعّل تاني، لأن البرنامج بيشتغل من غير نت.
- **الحماية من التخمين:** 10 محاولات تفعيل في الساعة لكل عنوان IP، و10 محاولات كلمة سر غلط لصفحة الإدارة.

## In English, briefly

Cloudflare Worker + D1. Endpoints:
- `POST /v1/activate {key, machine, appVersion}` returns `{licence: {payload, signature}}`. Refusals: `licence_key_invalid` (404), `licence_revoked` (403), `licence_moves_exhausted` (409), `licence_rate_limited` (429).
- `/admin`: the admin page and its JSON API, behind HTTP Basic auth with `ADMIN_PASSWORD`.

Secrets: `LICENCE_PRIVATE_KEY` (Ed25519 PKCS#8, base64 DER or PEM) and `ADMIN_PASSWORD`. Neither is ever in the repo. Deploy steps are above. Tests run the Worker against SQLite: `npx vitest run licence-server`.
