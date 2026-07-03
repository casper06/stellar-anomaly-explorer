import { test, expect, type Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { openAppWithCatalog, panelName, searchPick } from './helpers'

/**
 * @description Formalizes the selection-generation guard (commit 862481b)
 * under the exact ordering that used to corrupt the panel: a STALE
 * lightcurve response landing AFTER a newer pick. Previously this needed
 * a cold MAST cache and luck; here `page.route()` interception serves the
 * repo's frozen fixtures with fully controlled ordering — deterministic
 * and offline-reproducible.
 *
 * Sequence: pick K02357.02 (response HELD) → pick Tabby's Star (response
 * served immediately) → Tabby's real curve renders → release the held
 * K02357 response → panel must still show Tabby's data, loading must not
 * reappear or clear incorrectly.
 */

/** @description Loads a gzipped repo fixture and wraps it as a route payload. */
function fixturePayload(kicId: string): string {
  const file = path.join(__dirname, '..', 'src', 'lib', '__tests__', 'fixtures', `${kicId}.json.gz`)
  const { times, flux } = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as {
    times: number[]
    flux: number[]
  }
  return JSON.stringify({
    times,
    flux,
    source: 'real',
    provenance: { sourceName: 'NASA/MAST', mission: 'Kepler', dataType: 'PDCSAP flux' },
    mission: 'Kepler',
    gapDays: 5,
  })
}

test('stale lightcurve response arriving after a newer pick is discarded', async ({ page }) => {
  const tabbyBody = fixturePayload('KIC8462852')
  const k02357Body = fixturePayload('KIC7449554')

  let releaseStale: (() => Promise<void>) | null = null
  const staleHeld = new Promise<void>(resolveHeld => {
    void page.route('**/api/lightcurve/**', async (route: Route) => {
      const url = route.request().url()
      if (url.includes('KIC7449554')) {
        // Hold the stale star's response until the test releases it.
        releaseStale = () => route.fulfill({ contentType: 'application/json', body: k02357Body })
        resolveHeld()
        return
      }
      if (url.includes('KIC8462852')) {
        await route.fulfill({ contentType: 'application/json', body: tabbyBody })
        return
      }
      await route.continue()
    })
  })

  await openAppWithCatalog(page)

  // Pick #1: K02357.02 — its lightcurve request gets held in flight.
  await searchPick(page, 'K02357.02', /K02357/)
  await expect.poll(() => panelName(page)).toBe('K02357.02')
  await staleHeld

  // Pick #2 (newer): Tabby's Star — response served instantly from fixture.
  await searchPick(page, 'KIC8462852', /Tabby/i)
  await expect.poll(() => panelName(page)).toBe("Tabby's Star")
  await expect(page.getByText('REAL DATA')).toBeVisible()
  await expect(page.getByText('−20.69%')).toBeVisible() // Tabby's D1519 dip card

  // Release the stale response — the bug ordering. The guard must
  // discard it wholesale.
  expect(releaseStale, 'the K02357 request should have been intercepted').toBeTruthy()
  await releaseStale!()
  await page.waitForTimeout(2_000)

  expect(await panelName(page), 'stale response must not steal the panel').toBe("Tabby's Star")
  await expect(page.getByText('−20.69%')).toBeVisible()
  await expect(page.getByText('−1.00%')).toHaveCount(0) // K02357's dip never renders
  await expect(page.getByText('REAL DATA')).toBeVisible()
  await expect(page.getByText('LOADING', { exact: true })).toHaveCount(0)
})
