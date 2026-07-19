import { test, expect, type Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { openAppWithCatalog, panelName } from './helpers'

/**
 * @description Formalizes phase B3 mechanism (b): the explicit
 * press-Enter-to-ask-SIMBAD escape hatch in the search box, for a common
 * name belonging to a star the user has never opened (so no local alias
 * exists to match).
 *
 * `/api/identity/*` is INTERCEPTED and served from the repo's frozen
 * SIMBAD fixtures, for three reasons: the run stays offline and
 * deterministic, it cannot be flaked by a CDS outage, and — the real
 * point — it must never put CI traffic on a service whose fair-use
 * policy blacklists IPs above ~5–10 queries/second.
 *
 * The three outcomes pinned here are the whole design:
 *   - matched      → behaves like an ordinary successful search.
 *   - not-tracked  → SIMBAD knows the name, we don't render it: say so,
 *                    and do NOT move the camera.
 *   - unknown      → SIMBAD doesn't know the name.
 * Plus the rate-posture invariant: typing fires ZERO queries.
 */

const FIXTURE_DIR = path.join(__dirname, '..', 'src', 'lib', '__tests__', 'fixtures', 'simbad')

/** @description Reads a frozen SIMBAD fixture's raw TAP response body. */
function fixtureResponse(name: string): unknown {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as {
    response: unknown
  }
  return raw.response
}

/**
 * @description Serves `/api/identity/*` from frozen fixtures, mapping the
 * looked-up name to the record SIMBAD really returns for it. Counts calls
 * so the "no per-keystroke queries" invariant is checkable.
 * @param page Playwright page.
 * @returns A counter object whose `n` is the number of identity requests.
 */
async function stubIdentity(page: import('@playwright/test').Page): Promise<{ n: number }> {
  const counter = { n: 0 }
  await page.route('**/api/identity/**', async (route: Route) => {
    counter.n++
    const url = decodeURIComponent(route.request().url())
    const key = url.split('/api/identity/')[1].split('?')[0].toLowerCase().replace(/\s+/g, '')
    // Tabby's record is what SIMBAD returns for "Boyajian's Star" — the
    // ident join matches any alias, so name and id resolve identically.
    const body =
      key.includes('boyajian') || key.includes('8462852')
        ? { source: 'real', identity: null, fetchedAt: Date.now(), _fixture: 'KIC8462852' }
        : key === 'm31' || key.includes('andromeda')
          ? { source: 'real', identity: null, fetchedAt: Date.now(), _fixture: 'M31' }
          : { source: 'real', identity: null, fetchedAt: Date.now(), _fixture: null }
    // Parse the fixture server-side of the boundary: the route returns a
    // PARSED identity, so mirror that shape rather than the raw TAP body.
    const fixture = body._fixture
    if (fixture) {
      const resp = fixtureResponse(fixture) as { data: unknown[][] }
      const row = resp.data[0]
      const ids = String(row[4]).split('|').map(s => s.replace(/\s+/g, ' ').trim())
      const grab = (re: RegExp): string | null => {
        for (const id of ids) { const m = id.match(re); if (m) return m[1] }
        return null
      }
      const commonNames: string[] = []
      for (const id of ids) {
        const n = id.startsWith('NAME ') ? id.slice(5) : /^(?:HAT-P|WASP|Kepler|KOI|K2|TOI)-\d+$/.test(id) ? id : null
        if (n && !commonNames.includes(n)) commonNames.push(n)
      }
      body.identity = {
        mainId: String(row[0]).replace(/\s+/g, ' ').trim(),
        otype: row[1] ?? null,
        ra: row[2] ?? null,
        dec: row[3] ?? null,
        kic: grab(/^KIC (\d+)$/),
        tic: grab(/^TIC (\d+)$/),
        epic: grab(/^EPIC (\d+)$/),
        hip: grab(/^HIP (\d+)$/),
        gaiaDr3: grab(/^Gaia DR3 (\d+)$/),
        twoMass: grab(/^2MASS (J\S+)$/),
        tycho: grab(/^TYC (\S+)$/),
        commonNames,
        allIds: ids,
      } as never
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return counter
}

/** @description Types a query into the search box and waits out the debounce. */
async function typeQuery(page: import('@playwright/test').Page, q: string): Promise<void> {
  const search = page.locator('input[placeholder^="Search star"]')
  await search.fill('')
  await page.waitForTimeout(150)
  await search.focus()
  await search.pressSequentially(q, { delay: 25 })
  await page.waitForTimeout(400)
}

test.describe('ask SIMBAD escape hatch (phase B3 mechanism (b))', () => {
  test('a common name for an unopened star resolves and selects it', async ({ page }) => {
    await stubIdentity(page)
    await openAppWithCatalog(page)

    await typeQuery(page, "Boyajian's Star")
    // Local search alone cannot find it — that is the precondition for
    // the escape hatch even existing.
    await expect(page.getByText(/No star found matching/)).toBeVisible()
    await expect(page.getByText(/Press Enter to ask SIMBAD/)).toBeVisible()

    await page.locator('input[placeholder^="Search star"]').press('Enter')
    await expect.poll(async () => await panelName(page), { timeout: 30_000 }).toMatch(/Tabby/i)
  })

  test('a recognized object we do not track says so and does NOT move the camera', async ({ page }) => {
    await stubIdentity(page)
    await openAppWithCatalog(page)

    const pointingBefore = await page.getByText(/RA [\d.]+° · DEC/).first().textContent()

    await typeQuery(page, 'M31')
    await page.locator('input[placeholder^="Search star"]').press('Enter')

    await expect(page.getByText(/SIMBAD recognizes/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/isn't in our tracked Kepler\/TESS\/Hipparcos catalog/)).toBeVisible()

    // The point of the whole feature: no flight to empty sky.
    await page.waitForTimeout(1500)
    const pointingAfter = await page.getByText(/RA [\d.]+° · DEC/).first().textContent()
    expect(pointingAfter).toBe(pointingBefore)
    expect(await panelName(page)).toBeNull()
  })

  test('an unrecognized name is reported as unknown, not as an error', async ({ page }) => {
    await stubIdentity(page)
    await openAppWithCatalog(page)

    await typeQuery(page, 'zzqqxxnotastar')
    await page.locator('input[placeholder^="Search star"]').press('Enter')

    await expect(page.getByText(/SIMBAD doesn't know the name/)).toBeVisible({ timeout: 30_000 })
  })

  test('typing fires ZERO SIMBAD queries; only the explicit Enter does', async ({ page }) => {
    const counter = await stubIdentity(page)
    await openAppWithCatalog(page)

    await typeQuery(page, 'Boyajian')
    await page.waitForTimeout(1200)
    expect(counter.n, 'typing must never query CDS (fair-use rate posture)').toBe(0)

    await page.locator('input[placeholder^="Search star"]').press('Enter')
    await expect.poll(() => counter.n, { timeout: 30_000 }).toBe(1)
  })
})
