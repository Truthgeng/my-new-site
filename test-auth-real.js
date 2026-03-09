const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    // Listen for console logs
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    // 1. Visit the app normally (no tokens in URL)
    await page.goto(`http://localhost:3000`);

    try {
         // Wait for initial session to fire
         await page.waitForTimeout(2000);
         
         const authAreaHTML = await page.evaluate(() => document.getElementById('authArea').innerHTML);

         console.log("TEST: App loaded without tokens in URL");
         console.log("Auth Area HTML:", authAreaHTML);

    } catch(e) {
         console.error("TEST FAILED:", e);
    }
    await browser.close();
})();
