/** The first-use setup (#97, note 10): sales and purchases open once it is finished. */
export type SetupMode = "opening" | "new" | "existing";
export type SetupStatus = {
    finished: boolean;
    mode: SetupMode | null;
    finishedAt: string | null;
    warehouses: number;
    items: number;
    /** Entries that brought balances in (stock, money, customers, suppliers), voids left out. */
    openingEntries: number;
    users: number;
};
