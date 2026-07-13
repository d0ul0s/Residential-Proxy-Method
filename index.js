const puppeteer = require('puppeteer');

// The script now waits for the UI/Backend to hand it these two variables
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
        const cookies = JSON.parse(process.env.FACEBOOK_COOKIES);
        await page.setCookie(...cookies);

        console.log(`Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        const messageBoxSelector = 'div[aria-label="Message"]'; 
        await page.waitForSelector(messageBoxSelector);
        
        await page.type(messageBoxSelector, targetMessage, { delay: 50 });
        await page.keyboard.press('Enter');
        
        console.log(`Successfully sent: "${targetMessage}"`);

    } catch (error) {
        console.error("Automation failed:", error);
    } finally {
        await browser.close();
    }
}

sendSpecificMessage();
