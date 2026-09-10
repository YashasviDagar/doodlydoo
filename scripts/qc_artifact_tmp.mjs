import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1400 } })).newPage();
await page.goto("https://claude.ai/code/artifact/51cf0c72-0851-420f-ab16-741d9af3a160", { waitUntil: "networkidle", timeout: 20000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: "C:/Users/HP/AppData/Local/Temp/claude/d--doodlydoo/fcb68bd5-517e-4b60-880c-58ad27cfe6c9/scratchpad/qc-full.png", fullPage: true });
console.log("done");
await browser.close();
