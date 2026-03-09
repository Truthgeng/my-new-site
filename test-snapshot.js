const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('http://localhost:3000');

    // Make sure we simulate logging in by setting a test token
    await page.evaluate(() => {
        window.localStorage.setItem('sb-bqjvgsivwhnyjnzpglrd-auth-token', JSON.stringify({
            "access_token": "mock_token",
            "token_type": "bearer",
            "expires_at": Math.floor(Date.now() / 1000) + 3600,
            "user": { "id": "test_user_id", "email": "test@example.com" }
        }));
    });
    await page.reload();

    // Fill the fields
    await page.type('#xLink', 'https://x.com/JupiterExchange');
    await page.type('#niche', 'DeFi Analyst');

    // Evaluate in the context of the page to trigger the fetch directly
    await page.evaluate(async () => {
        // mock sb.auth.getSession since sb might not be defined on window immediately
        const mockAuth = {
            getSession: async () => ({
                data: { session: { access_token: "mock" } }
            })
        };
        // wait for window.sb to be defined, then overwrite it
        if (!window.sb) {
            window.sb = {
                auth: mockAuth
            };
        } else {
            window.sb.auth.getSession = mockAuth.getSession;
        }

        window.currentUser = { id: "test", email: "test@example.com" };
        window.isPro = true; // allow unlimited generations for test
        document.getElementById('generateBtn').click();
    });

    try {
        await page.waitForSelector('#snapshotContainer .snapshot-card', { timeout: 15000 });
        const snapshotText = await page.evaluate(() => document.getElementById('snapshotContainer').innerText);
        console.log("SNAPSHOT GENERATED SUCCESSFULLY:\n", snapshotText);

        await page.waitForSelector('#pitchContent .pitch-text', { timeout: 15000 });
        console.log("PITCH GENERATED SUCCESSFULLY");
    } catch (e) {
        console.error("SNAPSHOT FAILED TO GENERATE");
        const errorMsg = await page.evaluate(() => document.getElementById('errorMsg').innerText);
        console.error("UI Error Message:", errorMsg);
        process.exit(1);
    }

    await browser.close();
})();
