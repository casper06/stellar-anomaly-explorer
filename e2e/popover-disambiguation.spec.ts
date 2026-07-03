import { test, expect } from '@playwright/test'
import { openAppWithCatalog, panelName, searchPick, zoomIntoAutoSelectRange } from './helpers'

/**
 * @description Formalizes the disambiguation popover behavior (fixed
 * 2026-07-02, commit 214d132): the screen-distance filter projects each
 * star's own position, so dense-field popovers list a handful of
 * genuinely-close candidates (single digits, not the 20–30 the old
 * ray-point projection produced), and picking a non-centered row
 * registers and persists (commit 862481b's transition guard).
 */
test('dense-field popover lists few real candidates and an off-center pick sticks', async ({ page }) => {
  await openAppWithCatalog(page)

  // Deterministic dense field: fly to K02357.02 (KOI-core) and zoom in.
  await searchPick(page, 'K02357.02', /K02357/)
  await expect.poll(() => panelName(page)).toBe('K02357.02')
  await page.waitForTimeout(2_000)
  await zoomIntoAutoSelectRange(page)

  // Fixed click grid (same grid used for the before/after fix
  // measurements). Collect popover candidate counts; assert every
  // popover stays single-digit and at least one opened.
  const grid: Array<[number, number]> = [
    [450, 250], [600, 250], [750, 250], [900, 250],
    [450, 400], [600, 400], [750, 400], [900, 400],
    [450, 550], [600, 550], [750, 550], [900, 550],
  ]
  let popover: { rows: string[] } | null = null
  const counts: number[] = []
  for (const [x, y] of grid) {
    await page.mouse.click(x, y)
    await page.waitForTimeout(350)
    const header = page.getByText('STARS AT THIS POINT')
    if (await header.count()) {
      const rowLoc = header.locator('xpath=../..').locator('button')
      const n = await rowLoc.count()
      counts.push(n)
      expect(n, 'post-fix candidate counts must be single-digit').toBeLessThan(10)
      const titles: string[] = []
      for (let i = 0; i < n; i++) titles.push((await rowLoc.nth(i).getAttribute('title')) ?? '')
      // Keep the LAST popover open for the pick assertion below.
      popover = { rows: titles }
      const current = await panelName(page)
      const pickable = titles.filter(t => t && t !== current)
      if (pickable.length > 0) {
        const pick = pickable[pickable.length - 1] // least likely centered
        await rowLoc.nth(titles.lastIndexOf(pick)).click()
        await expect.poll(() => panelName(page)).toBe(pick)
        await page.waitForTimeout(2_500) // old bug stole it within one frame
        expect(await panelName(page), 'off-center pick must persist').toBe(pick)
        return // full scenario exercised
      }
      await page.mouse.click(30, 870) // dismiss, keep scanning
      await page.waitForTimeout(250)
    }
  }
  // If we get here no popover offered a pickable row — the count
  // assertions still ran, but the scenario is incomplete. Fail loudly
  // so flakiness is visible rather than silently green.
  expect(popover, `popover with a pickable row expected somewhere on the grid (counts seen: ${counts.join(',')})`).toBeTruthy()
  expect.soft(counts.length, 'at least one popover should open on the dense grid').toBeGreaterThan(0)
  throw new Error('no popover offered a row differing from the current selection')
})
