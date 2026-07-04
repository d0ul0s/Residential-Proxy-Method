const puppeteer = require('puppeteer');

async function sendGroupMessage() {
    // The --no-sandbox flags are mandatory for GitHub Actions
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    try {
        // 1. Inject the cookies from GitHub Secrets
        const cookies = JSON.parse(process.env.FACEBOOK_COOKIES);
        await page.setCookie(...cookies);

        // 2. Navigate to the chat
        const groupChatUrl = 'https://www.messenger.com/t/YOUR_GROUP_CHAT_ID'; // Replace this!
        await page.goto(groupChatUrl, { waitUntil: 'networkidle2' });

        // 3. Generate your dynamic message
        const timeNow = new Date().toLocaleTimeString();
        const message = `Automated class reminder deployed at ${timeNow}!`;

        // 4. Type and send
        const messageBoxSelector = 'div[aria-label="Message"]'; 
        await page.waitForSelector(messageBoxSelector);
        await page.type(messageBoxSelector, message, { delay: 50 });
        await page.keyboard.press('Enter');

        console.log("Message deployed successfully.");

    } catch (error) {
        console.error("Automation failed:", error);
    } finally {
        await browser.close();
    }
}

sendGroupMessage();
