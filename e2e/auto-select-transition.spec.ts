import { test, expect } from '@playwright/test'
import { openAppWithCatalog, panelName, searchPick, zoomIntoAutoSelectRange, dragView } from './helpers'

/**
 * @description Formalizes the CameraSync transition-semantics behavior
 * (fixed 2026-07-02, commit 862481b): auto-select fires when camera
 * movement brings a NEW anomaly to center, and never steals an explicit
 * pick whose star is off-center.
 */
test('auto-select fires on centered-anomaly transitions and never steals an explicit pick', async ({ page }) => {
  await openAppWithCatalog(page)

  // Zoom into the auto-select regime (FOV ≤ 28). Whatever anomaly sits
  // near center should be auto-selected; if the initial pointing has
  // none inside the cone, a drag re-centers until one fires.
  await zoomIntoAutoSelectRange(page)
  let autoSelected = await panelName(page)
  for (let i = 0; i < 4 && !autoSelected; i++) {
    await dragView(page, -220, -110)
    await page.waitForTimeout(2_000)
    autoSelected = await panelName(page)
  }
  expect(autoSelected, 'auto-select should fire once an anomaly is centered at FOV ≤ 28').toBeTruthy()

  // Explicit pick via search: flies to K02357.02, which becomes both
  // selected AND centered. The old bug overrode search picks mid-tween;
  // the fly-to suppression window plus transition guard must hold it.
  await searchPick(page, 'K02357.02', /K02357/)
  await expect.poll(() => panelName(page)).toBe('K02357.02')
  await page.waitForTimeout(4_000) // > 1.3s suppression + tween arrival
  expect(await panelName(page), 'search pick must survive suppression window + arrival').toBe('K02357.02')

  // Camera movement that centers a DIFFERENT anomaly must re-fire
  // auto-select — the feature still works after the guard fix.
  await expect(async () => {
    await dragView(page, -250, -120)
    await page.waitForTimeout(2_000)
    const now = await panelName(page)
    expect(now).toBeTruthy()
    expect(now).not.toBe('K02357.02')
  }).toPass({ timeout: 45_000, intervals: [500] })
})
