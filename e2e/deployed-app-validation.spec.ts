import { test, expect } from "@playwright/test";
import { existsSync } from "fs";
import { resolve } from "path";

const BASE_URL =
  process.env.TEST_BASE_URL ??
  "https://retail-app-7405618727830009.9.azure.databricksapps.com";
const SCREENSHOT_DIR = "e2e/screenshots/deployed";
const AUTH_FILE = resolve(process.cwd(), "e2e/.auth/databricks-auth.json");

// Country IDs from WorldMap (ISO 3166-1 numeric)
const GERMANY = "276";
const UNITED_STATES = "840";

test.describe("Deployed Retail App - Transaction Validation & Profile", () => {
  test.setTimeout(120000); // 2 min - may need OAuth

  test.use(
    existsSync(AUTH_FILE)
      ? { storageState: AUTH_FILE }
      : {}
  );

  test.beforeEach(async ({ page }) => {
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        console.log(`[CONSOLE ERROR] ${text}`);
      }
    });
  });

  test("Test 1: Transaction decline (international transaction)", async ({
    page,
  }) => {
    // 1. Navigate to main page
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 30000 });

    // Handle potential OAuth redirect - wait for app to load
    await page.waitForTimeout(3000);

    // Check if we hit a login page - do NOT skip, continue and capture screenshot
    const url = page.url();
    const hasLogin = url.includes("login") || url.includes("oidc") || await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (hasLogin) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/00-login-required.png`, fullPage: true });
      throw new Error("App requires OAuth login - please run in headed mode and log in first, or provide auth state");
    }

    // Wait for map to load
    await page.locator("svg path").first().waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(500);

    // 2. Click on Germany (non-US country)
    const germanyPath = page.getByTestId(`country-${GERMANY}`);
    await germanyPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(500);

    // 3. Verify amount slider and card number exist
    await expect(page.getByRole("button", { name: "Change" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('input[type="range"]')).toBeVisible();
    await expect(page.locator('input[placeholder="0000 0000 0000 0000"]').or(page.locator('input[value*=" "]'))).toBeVisible();

    // 4. Click Submit Transaction
    await page.getByRole("button", { name: "Submit Transaction" }).click();

    // 5. Wait for card tap animation - Transaction Declined
    await expect(page.getByText("Transaction Declined")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/international/i)).toBeVisible({ timeout: 5000 });

    // 6. Screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-transaction-declined.png`,
      fullPage: true,
    });
  });

  test("Test 2: Domestic transaction succeeds", async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes("login") || url.includes("oidc")) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/00-login-required.png`, fullPage: true });
      throw new Error("App requires OAuth login");
    }

    await page.locator("svg path").first().waitFor({ state: "visible", timeout: 15000 });

    // First select Germany, submit to get decline, then dismiss
    const germanyPath = page.getByTestId(`country-${GERMANY}`);
    await germanyPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Submit Transaction" }).click();
    await expect(page.getByText("Transaction Declined")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Dismiss - tap anywhere
    await page.locator(".fixed.inset-0.z-\\[100\\]").click();
    await page.waitForTimeout(500);

    // Deselect - click Germany again to deselect
    await germanyPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(300);

    // Select United States
    const usPath = page.getByTestId(`country-${UNITED_STATES}`);
    await usPath.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
    await page.waitForTimeout(500);

    // Submit
    await page.getByRole("button", { name: "Submit Transaction" }).click();

    // Expect Transaction Approved
    await expect(page.getByText("Transaction Approved")).toBeVisible({ timeout: 10000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-transaction-approved.png`,
      fullPage: true,
    });
  });

  test("Test 3: Profile page loads from Postgres", async ({ page }) => {
    await page.goto(`${BASE_URL}/profile`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes("login") || url.includes("oidc")) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/00-login-required.png`, fullPage: true });
      throw new Error("App requires OAuth login");
    }

    // Wait for profile to load
    await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Verify Allow International Transactions section exists (toggle OFF = gray/muted background)
    await expect(page.getByText("Allow International Transactions")).toBeVisible();
    await expect(page.getByText("Enable transactions from countries other than your residence")).toBeVisible();

    // Verify Country of Residence is United States
    await expect(page.getByText("Country of Residence")).toBeVisible();
    const countrySelect = page.locator('select').first();
    await expect(countrySelect).toHaveValue("United States");

    // Verify Daily limit is $5,000
    await expect(page.getByText("$5,000")).toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-profile-page.png`,
      fullPage: true,
    });
  });
});
