export type Role = "manager" | "accountant" | "cashier" | "storekeeper";
export type User = {
    id: number;
    name: string;
    role: Role;
    active: boolean;
};
export type NewUser = {
    name: string;
    role: Role;
    password: string;
};
export type UserChanges = {
    name?: string;
    role?: Role;
};
export type Credentials = {
    name: string;
    password: string;
};
export type AuditEntry = {
    id: number;
    /** When, as an ISO timestamp in UTC. */
    at: string;
    userId: number;
    userName: string;
    action: string;
    entityId: number | null;
    detail: string;
};
