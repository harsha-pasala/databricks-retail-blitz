import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:9000";
const SCREENSHOT_DIR = "e2e/screenshots";

test.describe("Transaction Page & Profile Page Tests", () => {
  test.beforeEach(async ({ page }) => {
    // Capture console messages for error reporting
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        console.log(`[CONSOLE ERROR] ${text}`);
      }
    });
  });

  test("Test 1 - Transaction page: initial load and map interactions", async ({
    page,
  }) => {
    test.setTimeout(60000); // Map loads geography from CDN
    // 1. Navigate to homepage
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    // Wait for map to load (geography from CDN)
    await page.locator("svg path").first().waitFor({ state: "visible", timeout: 15000 });

    // 2. Take screenshot of initial state
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-transaction-initial.png`,
      fullPage: true,
    });

    // 3. Click on a country - verify it gets selected (turns red)
    // Use dispatchEvent to bypass SVG stacking/interception issues
    const countryPath = page.getByTestId("country-124");
    await countryPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(500);

    // Verify country is selected - Change button appears in form
    await expect(page.getByRole("button", { name: "Change" })).toBeVisible({
      timeout: 5000,
    });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-country-selected.png`,
      fullPage: true,
    });

    // 4. Click SAME country again - verify it DESELECTS
    await countryPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(300);

    // Verify deselected - the "Click a country" hint should show
    const hint = page.locator('text=Click a country on the map to select it');
    await expect(hint).toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-country-deselected.png`,
      fullPage: true,
    });

    // 5. Re-select a country, then verify double-click does NOT zoom
    await countryPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(200);

    // Get map container dimensions before double-click
    const mapContainer = page.locator(".rsm-svg-element, svg").first();
    const boxBefore = await mapContainer.boundingBox();

    // Double-click on the map (on a country)
    await countryPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(300);

    // Verify no zoom - the map scale/transform should be unchanged
    // (If zoom worked, the SVG would have a transform)
    const boxAfter = await mapContainer.boundingBox();
    expect(boxBefore?.width).toBe(boxAfter?.width);
    expect(boxBefore?.height).toBe(boxAfter?.height);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-after-doubleclick.png`,
      fullPage: true,
    });

    // 6. Click Profile link in navbar
    await page.getByRole("link", { name: "Profile" }).click();
    await page.waitForURL("**/profile", { timeout: 5000 });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-navigated-to-profile.png`,
      fullPage: true,
    });
  });

  test("Test 2 - Profile page: verify all sections and check console", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Navigate directly to profile
    await page.goto(`${BASE_URL}/profile`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    // 2. Take screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-profile-page.png`,
      fullPage: true,
    });

    // 3. Verify Personal Information section
    await expect(
      page.getByRole("heading", { name: "Personal Information" })
    ).toBeVisible();
    await expect(page.getByText("Full Name")).toBeVisible();
    await expect(page.getByText("Email")).toBeVisible();
    await expect(page.getByText("Phone")).toBeVisible();
    await expect(page.getByText("Account ID")).toBeVisible();

    // 4. Verify Settings section
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Country of Residence")).toBeVisible();
    await expect(page.getByText("Preferred Currency")).toBeVisible();
    await expect(page.getByText("Daily Transaction Limit")).toBeVisible();
    await expect(
      page.getByText("Allow International Transactions")
    ).toBeVisible();
    await expect(page.getByText("Enable Notifications")).toBeVisible();
    await expect(page.getByText("Two-Factor Authentication")).toBeVisible();

    // 5. Verify Event Pipeline section
    await expect(
      page.getByRole("heading", { name: "Event Pipeline" })
    ).toBeVisible();
    await expect(page.getByText("EventHub connected")).toBeVisible();
    await expect(page.getByText("retail.user-profile-updates")).toBeVisible();

    // 6. Verify Save button
    await expect(
      page.getByRole("button", { name: "Save & Publish to EventHub" })
    ).toBeVisible();

    // 7. Report console errors
    await page.waitForTimeout(1000);
    if (consoleErrors.length > 0) {
      console.log("Console errors found:", consoleErrors);
    }

    // 8. Click Transactions link to go back
    await page.getByRole("link", { name: "Transactions" }).click();
    await page.waitForURL("**/", { timeout: 5000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-back-to-transactions.png`,
      fullPage: true,
    });
  });
});
