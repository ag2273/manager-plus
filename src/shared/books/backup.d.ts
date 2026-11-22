export type BackupFile = {
    path: string;
    name: string;
    at: string;
    size: number;
};
export type BackupStatus = {
    folder: string | null;
    lastBackupAt: string | null;
    backups: BackupFile[];
};
