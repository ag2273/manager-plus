# Backups with VACUUM INTO, a copy before every upgrade, and a lock file

Backups use SQLite's `VACUUM INTO`. It writes a consistent copy of the open database while the app keeps working, the same guarantee as the online backup API. Unlike the online backup API it is synchronous and gives a compact single file with no write-ahead log beside it. Backups go to a folder the manager picks. The folder is stored in the business file, because the PC that holds the file is the one that backs it up. That PC takes a backup the first time the file is open on each day, and checks again every five minutes while it stays open. The folder keeps this business's newest 30 backups and never touches other files.

Opening a file whose schema is older than the app first copies it beside itself as "<name> قبل التحديث <version>.mplus", then migrates. Migrations already run in one transaction. If one fails anyway, the file is closed and the copy is put back, so the file is exactly as it was.

Restoring backs up the current file first, then closes it, puts the chosen backup in its place and reopens it signed out. Only a manager on the PC that holds the file can restore.

While a file is open, a lock file sits next to it ("<file>.lock", with the PC's name and a timestamp refreshed every five minutes). Opening a file whose lock belongs to another PC and is less than 15 minutes old shows a warning. When the file is also inside Dropbox, OneDrive or Google Drive, the warning recommends server mode, because two PCs writing a synced SQLite file lose data. The lock warns but does not block, so a crashed PC can never lock the owner out.
