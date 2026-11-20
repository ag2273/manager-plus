import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Item, ItemInput, TaxCode } from "../../../core/items";
import type { Result } from "../../../shared/api";
import { formatMoney, parseMoney } from "../../../shared/money";
import { formatQuantity, parseQuantity } from "../../../shared/quantity";
import { business, errorText } from "../api";
import { ar } from "../strings";

type Filter = "active" | "inactive";

/** Item list with search, and the item form for adding or editing. */
export function Items() {
  const [items, setItems] = useState<Item[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await business.items({
      search,
      includeInactive: filter === "inactive",
    });
    if (result.ok)
      setItems(
        filter === "inactive"
          ? result.value.filter((i) => !i.active)
          : result.value,
      );
  }, [search, filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void business.taxCodes().then((r) => r.ok && setTaxCodes(r.value));
  }, []);

  const taxKind = (id: number) => taxCodes.find((t) => t.id === id)?.kind;

  return (
    <>
      <header className="screen-head">
        <div>
          <h1>{ar.nav.items}</h1>
          <span className="muted">
            {items.length} {ar.items.count} · {ar.items.stockLater}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setNotice(null);
            setEditing("new");
          }}
        >
          {ar.items.add}
        </button>
      </header>
      {notice && (
        <div role="status" className="ok">
          {notice}
        </div>
      )}
      {editing && (
        <ItemForm
          item={editing === "new" ? null : editing}
          taxCodes={taxCodes}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice(ar.items.saved);
            await reload();
          }}
        />
      )}
      <div className="row">
        <label className="field">
          {ar.items.search}
          <input
            type="search"
            placeholder={ar.items.searchHint}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div role="group" aria-label={ar.items.filter} className="pills">
          {(["active", "inactive"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className="pill pill-tall"
              aria-pressed={f === filter}
              onClick={() => setFilter(f)}
            >
              {ar.items.filters[f]}
            </button>
          ))}
        </div>
      </div>
      <section className="table-card" aria-label={ar.nav.items}>
        {items.length === 0 ? (
          <p className="muted empty">
            {search || filter === "inactive"
              ? ar.items.noMatch
              : ar.items.empty}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ar.items.item}</th>
                <th className="col-barcode">{ar.items.barcode}</th>
                <th className="col-unit">{ar.items.unit}</th>
                <th className="col-money">{ar.items.price}</th>
                <th className="col-type">{ar.items.tax}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.id}
                  className={`clickable${i.active ? "" : " inactive"}`}
                  tabIndex={0}
                  onClick={() => setEditing(i)}
                  onKeyDown={(e) => e.key === "Enter" && setEditing(i)}
                >
                  <td>
                    <div className="stack">
                      <span className="strong">{i.nameAr}</span>
                      {(i.nameEn || i.code) && (
                        <span className="muted small">
                          {[i.code, i.nameEn].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="muted small" dir="ltr">
                    {i.barcode}
                  </td>
                  <td>
                    {i.baseUnit}
                    {i.pack &&
                      ` · ${i.pack.name} ${formatQuantity(i.pack.size)}`}
                  </td>
                  <td className="num">{formatMoney(i.salePrice)}</td>
                  <td className="muted small">
                    {ar.taxKinds[taxKind(i.taxCodeId) ?? "standard"]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

type Draft = {
  nameAr: string;
  nameEn: string;
  code: string;
  baseUnit: string;
  barcode: string;
  salePrice: string;
  taxCodeId: number;
  egsCode: string;
  hasPack: boolean;
  packName: string;
  packSize: string;
  packBarcode: string;
  packPrice: string;
};

function toDraft(item: Item | null, taxCodes: TaxCode[]): Draft {
  return {
    nameAr: item?.nameAr ?? "",
    nameEn: item?.nameEn ?? "",
    code: item?.code ?? "",
    baseUnit: item?.baseUnit ?? "قطعة",
    barcode: item?.barcode ?? "",
    salePrice: item ? formatMoney(item.salePrice) : "",
    taxCodeId: item?.taxCodeId ?? taxCodes[0]?.id ?? 0,
    egsCode: item?.egsCode ?? "",
    hasPack: item?.pack != null,
    packName: item?.pack?.name ?? "كرتونة",
    packSize: item?.pack ? formatQuantity(item.pack.size) : "",
    packBarcode: item?.pack?.barcode ?? "",
    packPrice: item?.pack ? formatMoney(item.pack.salePrice) : "",
  };
}

function ItemForm({
  item,
  taxCodes,
  onClose,
  onSaved,
}: {
  item: Item | null;
  taxCodes: TaxCode[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => toDraft(item, taxCodes));
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });

  function toInput(): ItemInput | string {
    const salePrice = parseMoney(draft.salePrice);
    if (salePrice === null) return ar.errors["price_invalid"]!;
    let pack: ItemInput["pack"] = null;
    if (draft.hasPack) {
      const size = parseQuantity(draft.packSize);
      const packPrice = parseMoney(draft.packPrice);
      if (size === null) return ar.errors["pack_size_invalid"]!;
      if (packPrice === null) return ar.errors["price_invalid"]!;
      pack = {
        name: draft.packName,
        size,
        barcode: draft.packBarcode,
        salePrice: packPrice,
      };
    }
    return {
      nameAr: draft.nameAr,
      nameEn: draft.nameEn,
      code: draft.code,
      baseUnit: draft.baseUnit,
      barcode: draft.barcode,
      salePrice,
      taxCodeId: draft.taxCodeId,
      egsCode: draft.egsCode,
      pack,
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = toInput();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    const result: Result<unknown> = item
      ? await business.updateItem(item.id, input)
      : await business.addItem(input);
    setError(errorText(result));
    if (result.ok) await onSaved();
  }

  async function toggleActive() {
    if (!item) return;
    const result = item.active
      ? await business.deactivateItem(item.id)
      : await business.reactivateItem(item.id);
    setError(errorText(result));
    if (result.ok) await onSaved();
  }

  return (
    <form
      className="card"
      onSubmit={save}
      aria-label={item ? ar.items.editItem : ar.items.newItem}
    >
      <h2>{item ? ar.items.editItem : ar.items.newItem}</h2>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="row">
        <label className="field">
          {ar.items.nameAr}
          <input
            value={draft.nameAr}
            onChange={(e) => set({ nameAr: e.target.value })}
            autoFocus
          />
        </label>
        <label className="field">
          {ar.items.nameEn}
          <input
            dir="ltr"
            value={draft.nameEn}
            onChange={(e) => set({ nameEn: e.target.value })}
          />
        </label>
      </div>
      <div className="row">
        <label className="field">
          {ar.items.barcode}
          <input
            dir="ltr"
            value={draft.barcode}
            onChange={(e) => set({ barcode: e.target.value })}
          />
        </label>
        <label className="field narrow">
          {ar.items.code}
          <input
            value={draft.code}
            onChange={(e) => set({ code: e.target.value })}
          />
        </label>
        <label className="field narrow">
          {ar.items.baseUnit}
          <input
            placeholder={ar.items.baseUnitHint}
            value={draft.baseUnit}
            onChange={(e) => set({ baseUnit: e.target.value })}
          />
        </label>
      </div>
      <div className="row">
        <label className="field narrow">
          {ar.items.salePrice}
          <input
            dir="ltr"
            inputMode="decimal"
            value={draft.salePrice}
            onChange={(e) => set({ salePrice: e.target.value })}
          />
        </label>
        <label className="field narrow">
          {ar.items.taxCode}
          <select
            value={draft.taxCodeId}
            onChange={(e) => set({ taxCodeId: Number(e.target.value) })}
          >
            {taxCodes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {ar.items.egsCode}
          <input
            dir="ltr"
            value={draft.egsCode}
            onChange={(e) => set({ egsCode: e.target.value })}
          />
        </label>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.hasPack}
          onChange={(e) => set({ hasPack: e.target.checked })}
        />
        {ar.items.hasPack}
      </label>
      {draft.hasPack && (
        <div className="row">
          <label className="field narrow">
            {ar.items.packName}
            <input
              value={draft.packName}
              onChange={(e) => set({ packName: e.target.value })}
            />
          </label>
          <label className="field narrow">
            {ar.items.packSize}
            <input
              dir="ltr"
              inputMode="decimal"
              value={draft.packSize}
              onChange={(e) => set({ packSize: e.target.value })}
            />
          </label>
          <label className="field">
            {ar.items.packBarcode}
            <input
              dir="ltr"
              value={draft.packBarcode}
              onChange={(e) => set({ packBarcode: e.target.value })}
            />
          </label>
          <label className="field narrow">
            {ar.items.packPrice}
            <input
              dir="ltr"
              inputMode="decimal"
              value={draft.packPrice}
              onChange={(e) => set({ packPrice: e.target.value })}
            />
          </label>
        </div>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {ar.save}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {ar.cancel}
        </button>
        {item && (
          <button type="button" className="btn push-end" onClick={toggleActive}>
            {item.active ? ar.items.deactivate : ar.items.reactivate}
          </button>
        )}
      </div>
    </form>
  );
}
