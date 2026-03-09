const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    // Listen for console logs
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    // Visit the app with mock URL tokens. Wait for UI explicitly.
    const mockHash = '#access_token=eyJhbGciOiJIUzI1NiJ9.mock_token.mock_sig&refresh_token=mock_refresh&expires_in=3600&token_type=bearer&type=recovery';
    await page.goto(`http://localhost:3000/${mockHash}`);
    
    // Wait slightly longer in case UI takes a moment
    await new Promise(r => setTimeout(r, 4000));
    
    const uiData = await page.evaluate(() => {
        return {
           authArea: document.getElementById('authArea').innerHTML,
           currentUser: !!window.currentUser,
           lastLoadedUserId: window.lastLoadedUserId,
           isOAuthCallbackHandling: window.isOAuthCallbackHandling
        }
    });
    
    console.log("STATE:", uiData);
    
    await browser.close();
})();
