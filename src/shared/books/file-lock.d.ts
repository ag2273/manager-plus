/** Who has a business file open: written next to it as "<file>.lock" and refreshed while open. */
export type LockInfo = {
    host: string;
    pid: number;
    at: string;
};
