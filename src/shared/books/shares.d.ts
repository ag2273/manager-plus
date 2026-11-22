import type { Piastres } from "./ledger";
import type { Quantity } from "./items";
/** How much of a posted line's values earlier documents already took back. */
export type Taken = {
    quantity: Quantity;
    values: Piastres[];
};
