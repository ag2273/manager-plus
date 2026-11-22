import { type IsoDate, type Piastres } from "./ledger";
export type Shift = {
    id: number;
    userId: number;
    userName: string;
    openedAt: string;
    openingFloat: Piastres;
    closedAt: string | null;
    countedCash: Piastres | null;
    status: "open" | "closed";
};
export type CashInOut = {
    date: IsoDate;
    direction: "in" | "out";
    amount: Piastres;
    accountId: number;
    reason: string;
};
export type CloseShiftInput = {
    date: IsoDate;
    countedCash: Piastres;
};
export type ZReport = {
    shift: Shift;
    receipts: number;
    sales: {
        total: Piastres;
        net: Piastres;
        vat: Piastres;
        /** Cash is after change; credit is what was left on customers' accounts. */
        byMethod: {
            cash: Piastres;
            card: Piastres;
            wallet: Piastres;
            credit: Piastres;
        };
    };
    returns: Piastres;
    discounts: Piastres;
    cashIn: Piastres;
    cashOut: Piastres;
    openingFloat: Piastres;
    /** Float + cash taken for sales − cash refunds + cash in − cash out. */
    expectedCash: Piastres;
    countedCash: Piastres | null;
    /** Counted − expected: positive is cash over, negative cash short. */
    difference: Piastres | null;
};
