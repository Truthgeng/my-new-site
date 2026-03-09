const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    // Listen for console logs
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    const email = "truth7824@gmail.com";
    const pw = "1qw23e"; 
    
    await page.goto('http://localhost:3000', {waitUntil: 'networkidle2'});

    try {
         // Evaluate click instead of native puppeteer click to bypass overlays
         await page.evaluate(() => document.querySelector('header .auth-btn').click());
         
         // Wait for modal transition
         await new Promise(r => setTimeout(r, 500));
         
         // Type credentials
         await page.type('#signinEmail', email);
         await page.type('#signinPassword', pw);
         
         // Evaluate click Sign In
         await page.evaluate(() => document.querySelector('#signinBtn').click());
         
         // Wait for profile loading and UI update. Our code logs "Loading profile for..."
         // And when it's done it updates authArea HTML.
         await new Promise(r => setTimeout(r, 4000));
         
         const uiData = await page.evaluate(() => {
             return {
                authHTML: document.getElementById('authArea').innerHTML,
                currentUser: !!window.currentUser,
                userMenuVisible: !!document.querySelector('.user-menu')
             }
         });
         
         console.log("FINAL UI STATE:", uiData);

    } catch(e) {
         console.error("TEST FAILED:", e);
    }
    await browser.close();
})();
