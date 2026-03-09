const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    // Listen for console logs
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    // 1. Visit with a mock OAuth hash
    const mockHash = '#access_token=eyJhbGciOiJIUzI1NiJ9.mock_token.mock_sig&refresh_token=mock_refresh&expires_in=3600&token_type=bearer&type=recovery';
    await page.goto(`http://localhost:3000/${mockHash}`);

    try {
         // Wait for profile loading logic to finish and auth UI to update
         await page.waitForFunction(() => {
             return !!document.querySelector('.user-menu') || document.body.innerText.includes('Dashboard Overview') || window.currentUser;
         }, {timeout: 8000});

         const hasUserMenu = await page.evaluate(() => !!document.querySelector('.user-menu'));
         const userMenuDisplay = await page.evaluate(() => {
             const el = document.querySelector('.user-menu');
             if (!el) return null;
             const style = window.getComputedStyle(el);
             return { display: style.display, visibility: style.visibility, opacity: style.opacity };
         });
         
         const authAreaHTML = await page.evaluate(() => document.getElementById('authArea').innerHTML);

         console.log("TEST PASSED: UI updated successfully");
         console.log("User Menu Present?", hasUserMenu);
         console.log("User Menu CSS visibility:", userMenuDisplay);
         console.log("Auth Area HTML:", authAreaHTML);

    } catch(e) {
         console.error("TEST FAILED: UI failed to render logged in state:", e);
         process.exit(1);
    }
    await browser.close();
})();
