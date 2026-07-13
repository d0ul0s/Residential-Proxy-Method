const puppeteer = require('puppeteer');

const targetUrl = process.env.CHAT_URL;
const targetMessage = process.env.CHAT_MESSAGE;

async function sendSpecificMessage() {
    if (!targetUrl || !targetMessage) {
        console.error("Missing URL or Message. Check your YAML file!");
        return;
    }

    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    try {
        let cookies = JSON.parse(process.env.FACEBOOK_COOKIES);
        
        // --- NEW FIX: Forcefully strip sameSite from every cookie ---
        cookies = cookies.map(cookie => {
            // Delete sameSite entirely to avoid any type mismatch errors
            delete cookie.sameSite;
            
            // EditThisCookie sometimes exports 'hostOnly' which Puppeteer also dislikes
            delete cookie.hostOnly; 
            
            return cookie;
        });
        // -----------------------------------------------------------

        await page.setCookie(...cookies);


                console.log(`Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        // 1. Debug Check: Did Facebook log us out?
        const currentUrl = page.url();
        console.log(`Current URL after load: ${currentUrl}`);
        
        if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
            throw new Error("Facebook rejected the cookies and redirected to the login/checkpoint page. You need to export fresh cookies from your browser.");
        }

        // 2. Use a more robust selector for the Messenger text box
        const messageBoxSelector = 'div[role="textbox"][contenteditable="true"]'; 
        
        console.log("Waiting for the chat box to appear...");
        await page.waitForSelector(messageBoxSelector, { timeout: 20000 });
        
        console.log("Typing message...");
        await page.type(messageBoxSelector, targetMessage, { delay: 50 });
        
        console.log("Sending...");
        await page.keyboard.press('Enter');
        
        console.log(`Successfully sent: "${targetMessage}"`);

    } catch (error) {
        console.error("Automation failed:", error);
    } finally {
        await browser.close();
    }
}

sendSpecificMessage();
