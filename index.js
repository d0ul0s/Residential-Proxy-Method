const puppeteer = require('puppeteer');

const targetUrl = process.env.CHAT_URL;
const targetMessage = process.env.CHAT_MESSAGE;
const e2eePin = process.env.FB_E2EE_PIN;
const reminderTasksRaw = process.env.REMINDER_TASKS || '[]';
let reminderTasks = [];

try {
  reminderTasks = JSON.parse(reminderTasksRaw);
} catch (e) {
  console.error("Failed to parse REMINDER_TASKS", e);
}

async function runAutomation() {
    console.log("🚀 Starting Messenger Automation...");

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ];

    if (process.env.PROXY_SERVER) {
      puppeteerArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    }

    const browser = await puppeteer.launch({
      headless: true, // Set to false if testing locally
      args: puppeteerArgs
    });

    try {
        const page = await browser.newPage();

        // 1. Authenticate the Proxy
        if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
          await page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD,
          });
        }

        // 2. Load and sanitize Facebook Cookies
        let cookies = JSON.parse(process.env.FACEBOOK_COOKIES);
        cookies = cookies.map(cookie => {
            delete cookie.sameSite;
            return cookie;
        });
        await page.setCookie(...cookies);

        // ----------------------------------------------------
        // PHASE 1: DISPATCH MAIN GROUP MESSAGE (IF APPLICABLE)
        // ----------------------------------------------------
        if (targetMessage && targetMessage.trim() !== '') {
            console.log(`Navigating to group chat: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await page.waitForTimeout(3000); // Stabilization

            // Handle E2EE Popup if it appears
            await handleE2EEPopup(page, e2eePin);

            console.log("Focusing the chat box...");
            const textBoxes = await page.$$('div[role="textbox"]');
            if (textBoxes.length > 0) {
                const chatBox = textBoxes[textBoxes.length - 1]; // Usually the last one
                await chatBox.focus();
                
                console.log("Typing group message...");
                await page.keyboard.type(targetMessage, { delay: 30 });
                await page.waitForTimeout(1500);
                
                console.log("Sending group message...");
                await page.keyboard.press('Enter');
                await page.waitForTimeout(5000); // Wait for network dispatch
                
                console.log("✅ Successfully sent message to group!");
            } else {
                console.log("❌ Could not find group chat text box.");
            }
        } else {
            console.log("⏭️ Skipping Main Group Message (Dynamic Message was empty).");
        }

        // ----------------------------------------------------
        // PHASE 2: DISPATCH INDIVIDUAL ROLE REMINDERS
        // ----------------------------------------------------
        if (reminderTasks.length > 0) {
            console.log(`\n📬 Processing ${reminderTasks.length} Individual Role Reminders...`);

            for (let i = 0; i < reminderTasks.length; i++) {
                const task = reminderTasks[i];
                console.log(`\nNavigating to private chat: ${task.url}`);
                await page.goto(task.url, { waitUntil: 'networkidle2', timeout: 60000 });
                await page.waitForTimeout(3000);

                await handleE2EEPopup(page, e2eePin);

                // --- CHECK CHAT HISTORY FOR CONFIRMATION CODE ---
                console.log("Scanning recent chat history for confirmation code...");
                const chatHistoryText = await page.evaluate(() => {
                    return document.body.innerText; 
                });

                if (chatHistoryText.includes(task.expectedCode)) {
                    console.log(`✅ Member ALREADY CONFIRMED using code ${task.expectedCode}. Skipping reminder.`);
                    continue; // Skip to next task
                }

                // If not confirmed, send the reminder
                console.log(`❌ No confirmation code found. Sending nudge to member...`);
                const textBoxes = await page.$$('div[role="textbox"]');
                if (textBoxes.length > 0) {
                    const chatBox = textBoxes[textBoxes.length - 1];
                    await chatBox.focus();
                    
                    await page.keyboard.type(task.message, { delay: 30 });
                    await page.waitForTimeout(1000);
                    
                    await page.keyboard.press('Enter');
                    await page.waitForTimeout(3000); // Network dispatch
                    console.log("✅ Sent private reminder successfully.");
                } else {
                    console.log("❌ Could not find private chat text box.");
                }
            }
        }

        await page.screenshot({ path: 'debug.png', fullPage: true });
        console.log("📸 Saved debug screenshot.");

    } catch (error) {
        console.error("Execution Error:", error);
    } finally {
        await browser.close();
    }
}

async function handleE2EEPopup(page, pin) {
    try {
        // Facebook often throws a modal asking to Enter PIN for End-to-End Encryption
        // We look for common text or input fields related to this
        const e2eeInput = await page.$('input[type="password"], input[autocomplete="one-time-code"]');
        if (e2eeInput && pin) {
            console.log("🔒 E2EE PIN Pop-up detected. Entering PIN...");
            await e2eeInput.focus();
            await page.keyboard.type(pin, { delay: 50 });
            await page.waitForTimeout(1000);
            
            // Press Enter to submit
            await page.keyboard.press('Enter');
            
            // Wait for history to load
            console.log("Waiting for chat history to decrypt and load...");
            await page.waitForTimeout(6000); 
        } else {
            console.log("🔓 No E2EE PIN Pop-up detected, or no PIN provided.");
        }
    } catch (err) {
        console.log("Error handling E2EE popup, continuing...", err.message);
    }
}

runAutomation();
