const puppeteer = require('puppeteer');

const targetUrl = process.env.CHAT_URL;
const targetMessage = process.env.CHAT_MESSAGE;

async function sendSpecificMessage() {
    if (!targetUrl || !targetMessage) {
        console.error("Missing URL or Message. Check your YAML file!");
        return;
    }

    // 1. Launch Chrome with the Proxy Server attached
    const browser = await puppeteer.launch({
      headless: true, // or "new"
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--proxy-server=${process.env.PROXY_SERVER}` 
      ]
    });

    try {
        const page = await browser.newPage();

        // 2. Authenticate the Proxy
        await page.authenticate({
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD,
        });

        // 3. Load and sanitize Facebook Cookies
        let cookies = JSON.parse(process.env.FACEBOOK_COOKIES);
        cookies = cookies.map(cookie => {
            delete cookie.sameSite;
            delete cookie.hostOnly; 
            return cookie;
        });
        await page.setCookie(...cookies);

        console.log(`Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        // 4. Debug Check: Did Facebook log us out?
        const currentUrl = page.url();
        console.log(`Current URL after load: ${currentUrl}`);
        if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
            throw new Error("Facebook rejected the cookies. You need to export fresh cookies from your browser.");
        }

                const messageBoxSelector = 'div[role="textbox"][contenteditable="true"]'; 
        
        console.log("Waiting for the chat box to appear...");
        await page.waitForSelector(messageBoxSelector, { timeout: 20000 });
        
        // --- NEW FIX: Stabilization Delay ---
        // Give Facebook 3 seconds to finish loading chat history and stop redrawing the screen
                console.log("Waiting for Facebook to stabilize...");
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // --- NEW FIX: Get the LAST text box on the screen (the actual chat box) ---
                const allTextBoxes = await page.$$(messageBoxSelector);
        if (allTextBoxes.length === 0) throw new Error("No text boxes found!");
        
        const chatBox = allTextBoxes[allTextBoxes.length - 1];
        console.log(`Found ${allTextBoxes.length} text boxes. Focusing the chat box...`);
        
        // 1. Force the cursor into the box instead of clicking the padding
        await chatBox.focus();
        
        // 2. Wait 1 second for the cursor to actually start blinking
        await new Promise(resolve => setTimeout(resolve, 1000));

        await page.screenshot({ path: 'debug.png', fullPage: true });

        console.log("Typing message...");
        const lines = targetMessage.split('\n');
        for (let i = 0; i < lines.length; i++) {
            await page.keyboard.type(lines[i], { delay: 50 });
            if (i < lines.length - 1) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
            }
        }
        
        console.log("Waiting for Facebook to register the text...");
        // 3. Wait 1 second before pressing enter so Facebook activates the Send state
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log("Sending the completed message...");
        await page.keyboard.press('Enter');
        
        // Press enter one more time just in case it missed the first one
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.keyboard.press('Enter');
        
        console.log("Waiting for network dispatch...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log(`Successfully sent message to group!`);

    } catch (error) {
        console.error("Automation failed:", error);
    } finally {
        await browser.close();
    }
}

sendSpecificMessage();
