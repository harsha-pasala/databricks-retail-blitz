/**
 * Save Databricks app auth state for Playwright tests.
 * Run: bun run scripts/save-databricks-auth.ts
 *
 * A browser will open. Log in with your Databricks/Microsoft credentials.
 * Once the retail app loads (map visible), auth state is saved to e2e/.auth/
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const BASE_URL = "https://retail-app-7405618727830009.9.azure.databricksapps.com";
const AUTH_FILE = "e2e/.auth/databricks-auth.json";

async function main() {
  const authDir = dirname(AUTH_FILE);
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Navigating to app... Log in when prompted.");
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 60000 });

  console.log("Waiting for you to log in and reach the app (map visible)...");
  try {
    await page.locator("svg path").first().waitFor({ state: "visible", timeout: 120000 });
    console.log("App loaded! Saving auth state...");
    await context.storageState({ path: AUTH_FILE });
    console.log(`Auth saved to ${AUTH_FILE}`);
    console.log("You can now run: bun run playwright test e2e/deployed-app-validation.spec.ts");
  } catch {
    console.log("Timeout - map not detected. Saving current state anyway.");
    await context.storageState({ path: AUTH_FILE });
    console.log(`Auth saved to ${AUTH_FILE}`);
  }

  await browser.close();
}

main();
