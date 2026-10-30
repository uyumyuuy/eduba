import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ context }) => {
  // Do not send test traffic to the real analytics site.
  await context.route("https://static.cloudflareinsights.com/beacon.min.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
});

function fixturePdf(): Buffer {
  const content = "BT /F1 22 Tf 30 170 Td (EDUBA browser OCR) Tj 0 -35 Td /F1 12 Tf (Local projects stay on this device.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function selectFile(page: Page, button: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: button, exact: true }).click();
  await (await chooser).setFiles(file);
}

test("PDF → local OCR → correction → .eduba → reopen and recover, using static assets", async ({ page, context }) => {
  const errors: string[] = [], remote: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { void dialog.accept(); });
  page.on("request", request => { if (!request.url().startsWith("http://127.0.0.1:1421") && !request.url().startsWith("blob:") && !request.url().startsWith("data:")) remote.push(request.url()); });
  await context.addInitScript(() => {
    // Exercise the file input/download fallback used in browsers without file pickers.
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
  await page.goto("/");
  const beacon = page.locator('script[src="https://static.cloudflareinsights.com/beacon.min.js"]');
  await expect(beacon).toHaveCount(1);
  expect(JSON.parse((await beacon.getAttribute("data-cf-beacon"))!)).toEqual({ token: "ac0248e137a945d78a0d7a30aafad910" });
  await selectFile(page, "Import PDF", { name: "sample.pdf", mimeType: "application/pdf", buffer: fixturePdf() });
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  const initialDownload = page.waitForEvent("download");
  await modal.getByRole("button", { name: /^Save as 1 logical page/ }).click();
  const initial = await initialDownload;
  expect(initial.suggestedFilename()).toBe("sample.eduba");
  await expect(page.getByRole("button", { name: "OCR current", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await selectFile(page, "Model (.traineddata)", {
    name: "custom.traineddata", mimeType: "application/octet-stream",
    buffer: await readFile("public/browser-assets/models/eng_assyriology_scan_candidate_20260920_v1.traineddata"),
  });
  await expect(page.locator(".file-select")).toContainText("custom.traineddata");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "OCR current", exact: true }).click();
  await expect(page.getByRole("button", { name: "OCR current", exact: true })).toBeEnabled({ timeout: 90000 });
  await expect(page.locator(".app-shell")).not.toContainText("OCR failed:");
  await expect(page.getByText("OCR is complete.", { exact: true })).toBeVisible();
  // The layout detector identifies the synthetic large heading as an illustration.
  await expect(page.locator(".ocr-pane")).toContainText("Local projects stay on this device.");
  const originalHocrDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "hOCR", exact: true }).click();
  const originalHocr = await readFile((await (await originalHocrDownload).path())!, "utf8");
  expect(originalHocr).toContain("x_bboxes");
  const line = page.locator(".layout-svg g").filter({ hasText: "Local projects" }).first();
  await line.locator("rect").click();
  const editor = page.locator("textarea.line-overlay");
  await expect(editor).toBeVisible();
  await editor.fill("Local projects corrected locally");
  await editor.press("Enter");
  await expect(page.getByText("Save changes to the project file", { exact: true })).toBeVisible();
  const savedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = await savedDownload;
  const bytes = await readFile((await saved.path())!);
  expect(bytes.subarray(0, 15).toString()).toBe("SQLite format 3");
  await expect(page.getByText("Project file saved", { exact: true })).toBeVisible();
  await selectFile(page, "Open", { name: "sample.eduba", mimeType: "application/octet-stream", buffer: bytes });
  await expect(page.locator(".ocr-pane")).toContainText("Local projects corrected locally");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".ocr-pane")).toContainText("Local projects stay on this device.");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator(".ocr-pane")).toContainText("Local projects corrected locally");
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator(".ocr-pane")).toContainText("Local projects corrected locally");
  const exportedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "hOCR", exact: true }).click();
  const exported = await exportedDownload;
  const hocr = await readFile((await exported.path())!, "utf8");
  expect(hocr).toContain('name="eduba-hocr-version" content="1"');
  expect(hocr).toContain('name="eduba-hocr-coordinates" content="complete"');
  expect(hocr).toContain("x_edubapagetopdf");
  expect(hocr).toContain("corrected");
  expect(remote.length).toBeGreaterThan(0);
  expect(remote.every(url => url === "https://static.cloudflareinsights.com/beacon.min.js")).toBe(true);
  expect(errors).toEqual([]);
});

test("file handles save directly, preserve failed writes, and protect a second tab", async ({ page, context }) => {
  await context.addInitScript((pdf: number[]) => {
    const files = new Map<string, File>([["sample.pdf", new File([new Uint8Array(pdf)], "sample.pdf", { lastModified: 1 })]]);
    const state = { deny: false, fail: false, writes: 0, aborts: 0, saveName: "" };
    (window as unknown as { fileTest: typeof state }).fileTest = state;
    const handle = (name: string) => ({
      name,
      getFile: async () => files.get(name) ?? new File([], name, { lastModified: 0 }),
      requestPermission: async () => state.deny ? "denied" : "granted",
      queryPermission: async () => state.deny ? "denied" : "granted",
      createWritable: async () => {
        let pending = new Uint8Array();
        return {
          write: async (bytes: Uint8Array) => { if (state.fail) throw new Error("Disk full"); pending = new Uint8Array(bytes); },
          close: async () => { files.set(name, new File([pending], name, { lastModified: Date.now() })); state.writes++; },
          abort: async () => { state.aborts++; },
        };
      },
    });
    Object.defineProperty(window, "showOpenFilePicker", { value: async () => [handle("sample.pdf")], configurable: true });
    Object.defineProperty(window, "showSaveFilePicker", { value: async (options: { suggestedName: string }) => handle(state.saveName || options.suggestedName), configurable: true });
  }, [...fixturePdf()]);
  page.on("dialog", dialog => { void dialog.accept(); });
  await page.goto("/");
  await page.getByRole("button", { name: "Import PDF", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("checkbox", { name: "Automatically detect figures", exact: true }).uncheck();
  await modal.getByRole("button", { name: /^Save as 1 logical page/ }).click();
  await expect(page.getByText("Project file saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "OCR current", exact: true }).click();
  await expect(page.locator(".ocr-pane")).toContainText("EDUBA browser OCR", { timeout: 90000 });
  await expect(page.getByRole("button", { name: "Save project", exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { fileTest: { deny: boolean } }).fileTest.deny = true; });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.locator(".app-shell")).toContainText("Permission to save the project was not granted");
  expect(await page.evaluate(() => (window as unknown as { fileTest: { writes: number } }).fileTest.writes)).toBe(1);
  await page.evaluate(() => { (window as unknown as { fileTest: { deny: boolean; saveName: string } }).fileTest.deny = false; (window as unknown as { fileTest: { saveName: string } }).fileTest.saveName = "renamed.eduba"; });
  await page.getByRole("button", { name: "Save as…", exact: true }).click();
  await expect(page.locator(".project-title")).toContainText("renamed.eduba");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel(/^PSM/).selectOption("6");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.evaluate(() => { (window as unknown as { fileTest: { fail: boolean } }).fileTest.fail = true; });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.locator(".app-shell")).toContainText("Save failed: Disk full");
  expect(await page.evaluate(() => (window as unknown as { fileTest: { aborts: number } }).fileTest.aborts)).toBe(1);
  await page.evaluate(() => { (window as unknown as { fileTest: { fail: boolean } }).fileTest.fail = false; });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByText("Project file saved", { exact: true })).toBeVisible();

  const second = await context.newPage();
  await second.goto("/");
  await second.getByRole("button", { name: "Working projects", exact: true }).click();
  await expect(second.locator(".app-shell")).toContainText("already open in another tab");
  await page.close();
  await second.getByRole("button", { name: "Working projects", exact: true }).click();
  await expect(second.getByRole("dialog")).toContainText("renamed.eduba");
  await second.getByRole("button", { name: "renamed.eduba", exact: true }).click();
  await expect(second.locator(".ocr-pane")).toContainText("EDUBA browser OCR");
});
