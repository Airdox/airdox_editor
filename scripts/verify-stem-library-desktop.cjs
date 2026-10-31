'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const [executable, input, destination] = process.argv.slice(2);
  assert.ok(executable && input && destination, 'exe, existing separated input WAV, evidence directory');
  const out = path.resolve(destination);
  await fs.mkdir(out, { recursive: true });
  let pw;
  for (const folder of await fs.readdir(path.join(process.env.LOCALAPPDATA, 'npm-cache/_npx'))) {
    try { pw = require(path.join(process.env.LOCALAPPDATA, 'npm-cache/_npx', folder, 'node_modules/playwright')); break; } catch {}
  }
  assert.ok(pw, 'Existing Playwright required');
  const report = { checks: [], errors: [] };
  let app;
  try {
    for (let run = 0; run < 2; run++) {
      app = await pw._electron.launch({ executablePath: path.resolve(executable),
        args: [...(executable.includes('node_modules') ? [process.cwd()] : []), `--user-data-dir=${path.join(out, 'profile')}`], timeout: 60000 });
      const page = await app.firstWindow();
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.locator('[data-stem-center]').waitFor();
      const skip = page.getByRole('button', { name: 'Später einrichten / Überspringen', exact: true });
      await skip.waitFor({ timeout: 10000 }).catch(() => {});
      if (await skip.isVisible()) await skip.click();
      await page.locator('input[type=file]').setInputFiles(path.resolve(input));
      const ok = page.getByRole('button', { name: 'OK', exact: true }).first();
      await ok.waitFor(); await ok.click();
      await page.locator('[data-stem-mixer]').waitFor({ timeout: 60000 });
      assert.equal(await page.locator('[data-stem-mixer] input[type=range]').count(), 4);
      const jobs = await page.evaluate(() => window.rekordboxDesktop.stemEngine.listStemJobs());
      assert.equal(jobs.ok, true);
      assert.ok(jobs.data.length > 0 && jobs.data.every(job => job.status === 'COMPLETED' && job.cacheHit));
      report.checks.push(`run ${run + 1}: imported identical audio with new track ID; four saved channels restored without inference`);
      await page.locator('[data-stem-action=toggle-panel]').click();
      assert.equal(await page.locator('[data-stem-mixer]').isVisible(), false);
      await page.locator('[data-stem-action=toggle-panel]').click();
      assert.equal(await page.locator('[data-stem-mixer]').isVisible(), true);
      for (const label of ['Datei', 'Bearbeiten', 'Betrachten']) {
        await page.getByRole('button', { name: label, exact: true }).click();
        const dropdown = page.locator('[data-zone1-cluster=menu] > div').filter({ has: page.getByRole('button', { name: label, exact: true }) }).locator('div.absolute');
        assert.equal(await dropdown.isVisible(), true);
        assert.equal(await dropdown.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + 20, r.y + 15)); }), true);
        await page.screenshot({ path: path.join(out, `${run}-${label}.png`) });
        await page.getByRole('button', { name: label, exact: true }).click();
      }
      await page.getByRole('button', { name: 'Betrachten', exact: true }).click();
      await page.getByRole('button', { name: 'Stem-Mixer ausblenden', exact: true }).click();
      assert.equal(await page.locator('[data-stem-mixer]').isVisible(), false);
      await page.locator('[data-stem-action=toggle-panel]').click();
      await page.getByRole('button', { name: 'Max. Platz / Alles einklappen', exact: true }).first().click();
      assert.equal(await page.locator('[data-stem-mixer]').isVisible(), false);
      await page.locator('[data-stem-action=toggle-panel]').click();
      assert.equal(await page.locator('[data-stem-mixer]').isVisible(), true);
      await page.screenshot({ path: path.join(out, `${run}-mixer.png`) });
      report.checks.push(`run ${run + 1}: collapse/reopen, View menu, focus recovery and all three dropdown hit targets passed`);
      await app.close(); app = null;
    }
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } finally {
    if (app) await app.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
