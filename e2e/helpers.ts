import { expect, type Page } from '@playwright/test'

/**
 * @description Shared E2E helpers. These encode the interaction timings
 * proven across the manual verification sessions this suite formalizes
 * (search debounce 120 ms, FOV damping settle, catalog readiness poll).
 */

/**
 * @description Opens the app with onboarding pre-dismissed and waits until
 * the anomaly catalog is searchable (KOI+TOI merge finished) by polling
 * the search box for a known star's dropdown row.
 * @param page Playwright page.
 */
export async function openAppWithCatalog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('sae:onboarded:v1', '1') } catch { /* ignore */ }
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const search = page.locator('input[placeholder^="Search star"]')
  await search.waitFor({ timeout: 60_000 })
  await expect(async () => {
    await search.fill('K02357')
    await page.waitForTimeout(700)
    const rows = await page.getByText(/K02357/).count()
    expect(rows).toBeGreaterThanOrEqual(1)
  }).toPass({ timeout: 90_000, intervals: [1_000] })
  await search.fill('')
}

/**
 * @description Reads the star name from the AnomalyPanel header (the div
 * immediately preceding the bookmark toggle), or null when no panel is open.
 * @param page Playwright page.
 * @returns Trimmed star name or null.
 */
export async function panelName(page: Page): Promise<string | null> {
  const el = page.locator('button[title*="ookmark"]').locator('xpath=preceding-sibling::div[1]')
  if ((await el.count()) === 0) return null
  return (await el.first().textContent())?.trim() ?? null
}

/**
 * @description Selects a star via the header search: fills the query,
 * waits out the 120 ms debounce, clicks the last matching dropdown row.
 * @param page Playwright page.
 * @param query Text to type into the search box.
 * @param rowPattern Pattern identifying the dropdown row to click.
 */
export async function searchPick(page: Page, query: string, rowPattern: RegExp): Promise<void> {
  const search = page.locator('input[placeholder^="Search star"]')
  await search.fill(query)
  await page.waitForTimeout(500)
  await page.getByText(rowPattern).filter({ hasNot: page.locator('input') }).last().click()
}

/**
 * @description Wheel-zooms the sky to FOV ≈ 24° (inside the auto-select
 * regime, FOV ≤ 28) and waits for the FOV damping to settle.
 * @param page Playwright page.
 */
export async function zoomIntoAutoSelectRange(page: Page): Promise<void> {
  await page.mouse.move(600, 450)
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -95)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(2_500)
}

/**
 * @description Drags the sky view by (dx, dy) CSS pixels in ten smooth
 * steps from the canvas center — large enough to re-center a different
 * anomaly, never small enough to register as a click (<5 px).
 * @param page Playwright page.
 * @param dx Horizontal drag distance.
 * @param dy Vertical drag distance.
 */
export async function dragView(page: Page, dx: number, dy: number): Promise<void> {
  await page.mouse.move(600, 450)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(600 + (dx * step) / 10, 450 + (dy * step) / 10)
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
}
