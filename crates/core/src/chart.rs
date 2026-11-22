/** One account of the starting chart. Roles mark the accounts the app posts to automatically. */
pub struct TemplateAccount {
    pub code: &'static str,
    pub name: &'static str,
    pub kind: &'static str,
    pub role: Option<&'static str>,
}

const fn a(
    code: &'static str,
    name: &'static str,
    kind: &'static str,
    role: Option<&'static str>,
) -> TemplateAccount {
    TemplateAccount {
        code,
        name,
        kind,
        role,
    }
}

pub const ACCOUNT_TYPES: [&str; 5] = ["asset", "liability", "equity", "income", "expense"];

/**
 * Egyptian retail chart of accounts every new business starts with, the same as
 * `core/chart-of-accounts.ts`. Draft pending the accountant's review (see the BRD).
 */
pub const RETAIL_CHART_OF_ACCOUNTS: &[TemplateAccount] = &[
    a("1100", "نقدية الدرج", "asset", Some("cash_drawer")),
    a("1110", "الخزينة الرئيسية", "asset", Some("main_cash")),
    a("1120", "البنك", "asset", Some("bank")),
    a(
        "1130",
        "المحافظ الإلكترونية / إنستاباي",
        "asset",
        Some("wallet"),
    ),
    a(
        "1140",
        "حساب وسيط مدفوعات البطاقات",
        "asset",
        Some("card_clearing"),
    ),
    a("1200", "العملاء", "asset", Some("receivables")),
    a("1300", "المخزون", "asset", Some("stock")),
    a(
        "1400",
        "ضريبة القيمة المضافة على المشتريات",
        "asset",
        Some("input_vat"),
    ),
    a(
        "1410",
        "ضرائب خصم من المنبع لدى الغير",
        "asset",
        Some("withholding_receivable"),
    ),
    a("1500", "أثاث وتجهيزات المحل", "asset", None),
    a("2100", "الموردون", "liability", Some("payables")),
    a(
        "2200",
        "ضريبة القيمة المضافة على المبيعات",
        "liability",
        Some("output_vat"),
    ),
    a(
        "2300",
        "ضريبة القيمة المضافة المستحقة للمصلحة",
        "liability",
        Some("vat_payable"),
    ),
    a("2400", "مصروفات مستحقة", "liability", None),
    a(
        "2500",
        "ضريبة الخصم والإضافة المستحقة للمصلحة",
        "liability",
        Some("withholding_payable"),
    ),
    a("3100", "رأس المال", "equity", Some("capital")),
    a("3200", "جاري صاحب المحل", "equity", Some("owner_drawings")),
    a(
        "3300",
        "الأرباح المحتجزة",
        "equity",
        Some("retained_earnings"),
    ),
    a("3900", "أرصدة افتتاحية", "equity", Some("opening_balances")),
    a("4100", "المبيعات", "income", Some("sales")),
    a("4200", "أرباح جرد المخزون", "income", Some("stock_gain")),
    a("4300", "زيادة نقدية الدرج", "income", Some("cash_over")),
    a("4400", "أرباح فروق العملة", "income", Some("exchange_gain")),
    a(
        "5100",
        "تكلفة البضاعة المباعة",
        "expense",
        Some("cost_of_goods_sold"),
    ),
    a("5200", "خسائر وإعدام مخزون", "expense", Some("stock_loss")),
    a(
        "5300",
        "خسائر فروق العملة",
        "expense",
        Some("exchange_loss"),
    ),
    a("6100", "الإيجار", "expense", None),
    a("6200", "الكهرباء والمياه", "expense", None),
    a("6300", "الأجور والمرتبات", "expense", None),
    a("6400", "النقل والمشال", "expense", None),
    a("6500", "عمولات البنوك والبطاقات", "expense", None),
    a("6600", "مصروفات متنوعة", "expense", None),
    a("6700", "عجز نقدية الدرج", "expense", Some("cash_short")),
];
