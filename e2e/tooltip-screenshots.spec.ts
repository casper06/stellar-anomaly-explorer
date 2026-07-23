import { test } from '@playwright/test'
import { openAppWithCatalog, searchPick } from './helpers'

/**
 * @description Screenshot capture for the two tooltip/heading clarifications
 * (NASA SCORE in AnomalyPanel, OBJECTS OF INTEREST in the HUD counter card).
 *
 * This is a CAPTURE spec, not an assertion spec: it exists to produce
 * reviewable PNGs of copy that cannot be judged from source alone
 * (legibility and discoverability of a small dim-grey `?` glyph). It is
 * deliberately NOT part of the assertion suite's contract — it asserts
 * nothing, so it can never fail the build over a rendering nuance.
 *
 * Two different tooltip mechanisms are in play, and they screenshot
 * differently:
 *   - AnomalyPanel's `InfoBadge` is a REACT hover state (onMouseEnter →
 *     absolutely-positioned span), so `page.hover()` opens it and it
 *     appears in the screenshot normally.
 *   - The HUD heading uses the native `title` attribute (the same
 *     lightweight mechanism `PartialDataBadge` uses). Native title
 *     tooltips are painted by the BROWSER CHROME, not the page, so they
 *     never appear in a Playwright screenshot. To make that copy
 *     reviewable, the "open" capture renders the title text into a
 *     temporary DOM overlay styled to match how the OS tooltip presents
 *     it — the text is read from the live `title` attribute, so it cannot
 *     drift from what a user actually sees.
 *
 * Run: npx playwright test e2e/tooltip-screenshots.spec.ts
 * Output: e2e/screenshots/*.png
 */

const OUT = 'e2e/screenshots'

test('capture NASA SCORE tooltip (AnomalyPanel)', async ({ page }) => {
  await openAppWithCatalog(page)
  // Tabby's Star — a seeded known anomaly guaranteed present in the
  // catalog, and it carries a NASA score so the ring + badge render.
  await searchPick(page, 'KIC8462852', /Tabby|KIC8462852/)
  await page.waitForTimeout(2_500)

  const panel = page.locator('div').filter({ hasText: /NASA SCORE/ }).last()

  // 1a — resting state: is the `?` discoverable next to NASA SCORE?
  await page.screenshot({ path: `${OUT}/01-nasa-score-resting.png`, clip: { x: 1300, y: 0, width: 300, height: 520 } })

  // 1b — hovered: the React tooltip renders in-page.
  const badge = page.locator('span[tabindex="0"]').first()
  await badge.hover()
  await page.waitForTimeout(400)
  // Clip starts left of the panel so any residual overflow would be
  // VISIBLE rather than hidden by the crop — if the edge-aware shift ever
  // regresses, this screenshot shows it.
  await page.screenshot({ path: `${OUT}/02-nasa-score-tooltip-open.png`, clip: { x: 1130, y: 0, width: 470, height: 520 } })
  await panel.count() // keep the locator meaningful for debugging

  // Assert-by-measurement: the tooltip must sit fully inside the scrolling
  // panel. Logged (not asserted) to keep this a capture-only spec.
  const fit = await page.evaluate(() => {
    const b = document.querySelector('span[tabindex="0"]') as HTMLElement | null
    const tip = b?.querySelector('span') as HTMLElement | null
    const clip = b?.closest('[style*="overflow"]') as HTMLElement | null
    if (!tip || !clip) return null
    const t = tip.getBoundingClientRect(); const c = clip.getBoundingClientRect()
    return { tipLeft: t.left, tipRight: t.right, clipLeft: c.left, clipRight: c.right,
             insideLeft: t.left >= c.left, insideRight: t.right <= c.right }
  })
  console.log('NASA_SCORE_TOOLTIP_FIT=', JSON.stringify(fit))
})

test('capture a previously-clipped metadata badge (MAG)', async ({ page }) => {
  await openAppWithCatalog(page)
  await searchPick(page, 'KIC8462852', /Tabby|KIC8462852/)
  await page.waitForTimeout(2_500)

  // MAG sits in the same left-edge column that used to clip. The badge is
  // a SIBLING of the label text inside the row's label span, so it is
  // located via the row that contains "MAG" rather than by nesting.
  const magBadge = page
    .locator('div')
    .filter({ hasText: /^MAG\?/ })
    .locator('span[tabindex="0"]')
    .first()
  await magBadge.hover()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/05-mag-badge-tooltip-open.png`, clip: { x: 1130, y: 120, width: 470, height: 300 } })

  const fit = await page.evaluate(() => {
    const tips = Array.from(document.querySelectorAll<HTMLElement>('span[tabindex="0"] > span'))
    const tip = tips.find(t => t.textContent?.startsWith('Magnitude'))
    const clip = tip?.closest('[style*="overflow"]') as HTMLElement | null
    if (!tip || !clip) return null
    const t = tip.getBoundingClientRect(); const c = clip.getBoundingClientRect()
    return { tipLeft: t.left, clipLeft: c.left, insideLeft: t.left >= c.left, insideRight: t.right <= c.right }
  })
  console.log('MAG_TOOLTIP_FIT=', JSON.stringify(fit))
})

test('capture OBJECTS OF INTEREST heading (HUD counter card)', async ({ page }) => {
  await openAppWithCatalog(page)
  await page.waitForTimeout(2_500)

  // 2a — resting state: heading + `?` above the KEPLER/TESS rows.
  await page.screenshot({ path: `${OUT}/03-hud-counter-resting.png`, clip: { x: 0, y: 620, width: 420, height: 280 } })

  // 2b — the native `title` copy, rendered into a temporary overlay so it
  // is visible in a screenshot (browser-chrome tooltips are not captured).
  // The text is read from the live attribute — no hand-copied duplicate.
  await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll<HTMLElement>('div[title]')).find(
      el => el.textContent?.includes('OBJECTS OF INTEREST'),
    )
    if (!heading) return
    const box = heading.getBoundingClientRect()
    const tip = document.createElement('div')
    tip.textContent = heading.getAttribute('title') ?? ''
    Object.assign(tip.style, {
      position: 'fixed',
      left: `${box.left}px`,
      top: `${box.bottom + 8}px`,
      maxWidth: '380px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(0,0,0,0.95)',
      border: '1px solid rgba(76,201,240,0.4)',
      borderRadius: '4px',
      padding: '8px 10px',
      font: '11px/1.5 "JetBrains Mono", monospace',
      color: 'rgba(255,255,255,0.85)',
      zIndex: '9999',
    } as Partial<CSSStyleDeclaration>)
    tip.setAttribute('data-screenshot-tooltip', '1')
    document.body.appendChild(tip)
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/04-hud-counter-tooltip-open.png`, clip: { x: 0, y: 600, width: 460, height: 300 } })
})
