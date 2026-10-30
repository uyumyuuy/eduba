import { expect, test } from "@playwright/test";

test("browser build includes the Cloudflare page-view beacon", async ({ page, context }) => {
  await context.route("https://static.cloudflareinsights.com/beacon.min.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto("/");
  const beacon = page.locator('script[src="https://static.cloudflareinsights.com/beacon.min.js"]');
  await expect(beacon).toHaveCount(1);
  expect(JSON.parse((await beacon.getAttribute("data-cf-beacon"))!)).toEqual({ token: "ac0248e137a945d78a0d7a30aafad910" });
  await expect(page.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "../privacy/");
  await expect(page.getByText("PDFs and OCR content stay on your device.")).toBeVisible();
});
