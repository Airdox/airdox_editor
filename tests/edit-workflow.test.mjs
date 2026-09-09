/**
 * Edit-Workflow Playwright-Test (v0.4.3)
 * -------------------------------------
 * Führt alle 8 Edit-Aktionen + Palette-Insert systematisch durch und erzeugt
 * Screenshot-Beweise in tests/screenshots/.
 *
 * Nutzung (lokal mit installiertem Chromium):
 *   npm run dev &            # startet Vite auf :3001 (oder :3000)
 *   npx playwright install chromium
 *   node tests/edit-workflow.test.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.resolve('tests/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const URL = process.env.TEST_URL || 'http://localhost:3001/';

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log(' 📸', name);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE ERR:', m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // Audio-Boot + Default-Track
  await shot(page, '01_initial.png');

  // 8-Beat-Auswahl via Beat-Select-Panel
  await page.getByRole('button', { name: /^8\s*BEAT$/i }).click();
  await shot(page, '02_selection_8beat.png');

  // COPY
  await page.getByRole('button', { name: /^COPY$/i }).click();
  await shot(page, '03_copy.png');

  // CLONE (legt Auswahl als Palette-Clip an)
  const clipCountBefore = await page.locator('.border-\\[\\#22242d\\], .border-\\[\\#0088ff\\]').count();
  await page.getByRole('button', { name: /^CLONE$/i }).click();
  await page.waitForTimeout(500);
  await shot(page, '04_clone.png');

  // Palette-INSERT @ Playhead (der eigentliche Bugfix!):
  // Playhead irgendwohin setzen (z.B. Klick in Mitte der Waveform) und dann
  // beim ersten Palette-Clip auf INSERT @ ▶ klicken.
  const wf = page.locator('canvas').first();
  const wfBox = await wf.boundingBox();
  if (wfBox) {
    // Klicke auf Playhead-Position (linkes Drittel der Wellenform)
    await page.mouse.click(wfBox.x + wfBox.width * 0.3, wfBox.y + wfBox.height * 0.5);
    await page.waitForTimeout(200);
  }
  // Ersten Clip-Container finden und dort den INSERT @ ▶ Button klicken
  const firstClipInsertBtn = page.locator('button:has-text("INSERT @ ▶")').first();
  await firstClipInsertBtn.click();
  await page.waitForTimeout(800); // Audio-Re-Render
  await shot(page, '05_palette_insert.png');

  // CLEAR (8 Beat auswählen und stummschalten)
  await page.getByRole('button', { name: /^8\s*BEAT$/i }).click();
  await page.getByRole('button', { name: /^CLEAR$/i }).click();
  await shot(page, '06_clear.png');

  // UNDO → zurück vor Clear
  await page.getByRole('button', { name: /^UNDO$/i }).click();
  await shot(page, '12_undo.png');

  // 8 Beat auswählen, DELETE
  await page.getByRole('button', { name: /^8\s*BEAT$/i }).click();
  await page.getByRole('button', { name: /^DELETE$/i }).click();
  await shot(page, '07_delete.png');

  // PASTE aus Zwischenablage an aktueller Playhead-Position
  // Zuerst COPY wir einen neuen Bereich, damit Zwischenablage-Inhalt existiert
  await page.getByRole('button', { name: /^8\s*BEAT$/i }).click();
  await page.getByRole('button', { name: /^COPY$/i }).click();
  // Playhead versetzen
  if (wfBox) await page.mouse.click(wfBox.x + wfBox.width * 0.55, wfBox.y + wfBox.height * 0.5);
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: /^PASTE$/i }).click();
  await shot(page, '08_paste.png');

  // INSERT
  if (wfBox) await page.mouse.click(wfBox.x + wfBox.width * 0.2, wfBox.y + wfBox.height * 0.5);
  await page.getByRole('button', { name: /^INSERT$/i }).click();
  await shot(page, '09_insert.png');

  // REPLACE (benötigt Auswahl)
  await page.getByRole('button', { name: /^8\s*BEAT$/i }).click();
  await page.getByRole('button', { name: /^REPLACE$/i }).click();
  await shot(page, '10_replace.png');

  // Neuer Auswahlbereich für OVERDUB
  await page.getByRole('button', { name: /^8\s*BEAT$/i }).click();
  await page.getByRole('button', { name: /^OVERDUB$/i }).click();
  await shot(page, '11_overdub.png');

  // REDO
  await page.getByRole('button', { name: /^UNDO$/i }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /^REDO$/i }).click();
  await shot(page, '13_redo.png');

  console.log('\n✅ Alle Edit-Aktionen erfolgreich durchlaufen.');
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
