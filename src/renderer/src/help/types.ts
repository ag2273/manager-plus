/** The screens that have their own help: the main menu's screens, and the help manual itself. */
export type HelpScreen =
  | "home"
  | "till"
  | "items"
  | "warehouses"
  | "purchases"
  | "customers"
  | "salesInvoices"
  | "money"
  | "reports"
  | "accounts"
  | "users"
  | "audit"
  | "settings";

/** The fields with a "?" beside them. */
export type HelpField =
  | "businessName"
  | "taxRegistrationNumber"
  | "fiscalYearStart"
  | "itemBarcode"
  | "itemSalePrice"
  | "itemTaxCode"
  | "itemPack"
  | "itemEgsCode"
  | "itemSerials"
  | "purchaseReference"
  | "purchaseRate"
  | "shiftFloat"
  | "tillPaidNow"
  | "returnRefund"
  | "shiftCounted"
  | "customerTaxNumber"
  | "customerCreditLimit"
  | "openingBalance"
  | "lockDate";

export type ScreenHelp = {
  title: string;
  /** What the screen is for, in a sentence or two. */
  purpose: string;
  /** How to use it, step by step or point by point. */
  points: string[];
  /** The workflow guides that pass through this screen. */
  guides: string[];
};

export type GuideStep = { text: string; screen?: HelpScreen };

/** The steps of a whole task across screens. */
export type Guide = { id: string; title: string; summary: string; steps: GuideStep[] };

/** How the business side works: the ideas behind the screens. */
export type Concept = { id: string; title: string; paragraphs: string[] };

export type HelpContent = {
  manualTitle: string;
  manualIntro: string;
  searchLabel: string;
  searchHint: string;
  noResults: string;
  sections: { screens: string; guides: string; concepts: string; fields: string };
  screenHelp: string;
  openManual: string;
  close: string;
  goTo: string;
  fieldHelp: (label: string) => string;
  fields: Record<HelpField, string>;
  fieldNames: Record<HelpField, string>;
  screens: Record<HelpScreen, ScreenHelp>;
  guides: Guide[];
  concepts: Concept[];
};
