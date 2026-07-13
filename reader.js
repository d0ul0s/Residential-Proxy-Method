const puppeteer = require('puppeteer');

// These should be set in GitHub Action environment
const e2eePin = process.env.FB_E2EE_PIN;
const backendUrl = process.env.BACKEND_API_URL || 'https://dfcci-threshold.onrender.com';
const chatsToCheckStr = process.env.CHATS_TO_CHECK || '[]';
const referenceCode = process.env.REFERENCE_CODE; // e.g., DFCCI-S-LU-071926

let chatsToCheck = [];
try {
  chatsToCheck = JSON.parse(chatsToCheckStr);
} catch (e) {
  console.error("Failed to parse CHATS_TO_CHECK", e);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function runReader() {
    console.log("🚀 Starting Messenger Reader Bot...");

    if (!referenceCode) {
        console.error("❌ No REFERENCE_CODE provided. Exiting.");
        process.exit(1);
    }

    const puppeteerArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-features=site-per-process'
    ];

    if (process.env.PROXY_SERVER && process.env.PROXY_SERVER !== 'undefined' && process.env.PROXY_SERVER.trim() !== '') {
        puppeteerArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);
        console.log("🔒 Running with external proxy.");
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: puppeteerArgs
    });

    try {
        const page = await browser.newPage();
        
        await page.setViewport({ width: 1280, height: 800 });
        
        // Proxy auth
        if (process.env.PROXY_USERNAME && process.env.PROXY_USERNAME !== 'undefined' && process.env.PROXY_USERNAME.trim() !== '') {
          await page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD,
          });
        }

        // Load Cookies
        let cookies = JSON.parse(process.env.FACEBOOK_COOKIES);
        cookies = cookies.map(cookie => {
            delete cookie.sameSite;
            return cookie;
        });
        await page.setCookie(...cookies);

        for (const chat of chatsToCheck) {
            console.log(`\n🔍 Checking chat: ${chat.url} for role [${chat.role}]`);
            await page.goto(chat.url, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(5000); 

            // Check for E2EE popup
            const e2eeInputs = await page.$$('input[type="password"]');
            if (e2eeInputs.length > 0 && e2eePin) {
                console.log("🔒 E2EE PIN Pop-up detected. Entering PIN...");
                await e2eeInputs[0].type(e2eePin, { delay: 100 });
                await page.keyboard.press('Enter');
                console.log("Waiting for chat history to decrypt and load...");
                await delay(10000); 
            }

            // Scrape the latest messages
            // Messenger usually uses divs with specific roles or data-testid for messages
            // `div[dir="auto"]` is commonly used for message text content in the new UI
            const messageElements = await page.$$('div[dir="auto"]');
            
            // We want to check the most recent messages (last 5 or so)
            const recentElements = messageElements.slice(-10);
            let foundSubmission = null;

            for (const el of recentElements) {
                const text = await page.evaluate(el => el.innerText, el);
                
                // If this message starts with the reference code!
                if (text && text.trim().startsWith(referenceCode)) {
                    foundSubmission = text;
                }
            }

            if (foundSubmission) {
                console.log(`✅ Found submission for ${chat.role}!`);
                console.log(`Preview: ${foundSubmission.substring(0, 50)}...`);

                // Send a Thank You reply
                console.log("Sending acknowledgment...");
                const textBoxes = await page.$$('div[role="textbox"]');
                if (textBoxes.length > 0) {
                    const chatBox = textBoxes[textBoxes.length - 1];
                    await chatBox.focus();
                    await page.keyboard.type(`Thank you! I have recorded your lineup for ${referenceCode}.`, { delay: 10 });
                    await delay(500);
                    await page.keyboard.press('Enter');
                    await delay(2000);
                }

                // POST to our backend API!
                try {
                    const res = await fetch(`${backendUrl}/api/submissions/report`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            referenceCode: referenceCode,
                            role: chat.role,
                            content: foundSubmission
                        })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        console.log(`📤 Successfully reported submission to backend. Complete status: ${data.isComplete}`);
                    } else {
                        console.error(`❌ Backend rejected submission: ${data.error}`);
                    }
                } catch (e) {
                    console.error("❌ Failed to contact backend API", e);
                }

            } else {
                console.log(`⏳ No matching submission found for ${chat.role}.`);
            }
        }
        
    } catch (error) {
        console.error("Execution Error:", error);
    } finally {
        await browser.close();
        console.log("🏁 Browser closed.");
    }
}

runReader();
