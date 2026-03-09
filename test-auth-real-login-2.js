const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    // Listen for console logs
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    const timestamp = Date.now();
    const email = `test_${timestamp}@example.com`;
    const pw = "1qw23e"; 
    
    await page.goto('http://localhost:3000', {waitUntil: 'networkidle2'});

    try {
         console.log("TEST: Creating account:", email);
         
         // Open auth modal
         await page.evaluate(() => document.querySelector('header .auth-btn').click());
         await new Promise(r => setTimeout(r, 500));
         
         // Switch to sign up
         await page.evaluate(() => document.getElementById('tabSignUp').click());
         await new Promise(r => setTimeout(r, 200));
         
         // Type credentials
         await page.type('#signupEmail', email);
         await page.type('#signupPassword', pw);
         
         // Click Sign Up
         await page.evaluate(() => document.querySelector('#signupBtn').click());
         
         // Wait for Supabase to finish sign up (which often auto-logs in if email confirmation is off)
         await new Promise(r => setTimeout(r, 4000));
         
         const uiData = await page.evaluate(() => {
             return {
                authHTML: document.getElementById('authArea').innerHTML,
                currentUser: !!window.currentUser,
                userMenuVisible: !!document.querySelector('.user-menu')
             }
         });
         
         console.log("FINAL UI STATE AFTER SIGN UP:", uiData);

    } catch(e) {
         console.error("TEST FAILED:", e);
    }
    await browser.close();
})();
