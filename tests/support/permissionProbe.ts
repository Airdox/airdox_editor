/**
 * Hilfe für Tests, die „kein Schreibrecht" simulieren.
 *
 * `chmod(dir, 0o500)` ist auf POSIX wirksam, auf Windows aber bedeutungslos
 * (dort steuern ACLs den Zugriff) und unter Root ebenfalls. Ein Test, der dann
 * `WRITE_DENIED` erwartet, schlägt auf dem Windows-Runner fehl, ohne dass am
 * Produktcode etwas kaputt wäre. Also: erst prüfen, ob die Simulation überhaupt
 * greift – wenn nicht, den Fall dokumentiert überspringen statt rot melden.
 */
import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** true, wenn in das Verzeichnis trotz chmod 0o500 geschrieben werden kann. */
export async function simulateWriteDenial(dir: string): Promise<boolean> {
  await chmod(dir, 0o500);
  // Ein access()-Test auf eine nicht existierende Datei liefert ENOENT statt
  // EACCES – also wirklich anlegen und den Fehler ansehen.
  const probe = path.join(dir, '.airdox-probe');
  try {
    await writeFile(probe, 'probe', { flag: 'wx' });
    await rm(probe, { force: true });
    return true; // Schreibdatei angelegt, obwohl 0o500 ⇒ Simulation greift nicht
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EACCES' || code === 'EPERM') return false;
    throw error;
  }
}

/** Rechte wiederherstellen – auch dann, wenn der Fall übersprungen wurde. */
export async function restoreWriteAccess(dir: string): Promise<void> {
  await chmod(dir, 0o700);
}
