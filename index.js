const puppeteer = require('puppeteer');

const targetUrl = process.env.CHAT_URL;
const targetMessage = process.env.CHAT_MESSAGE;
const codeMessage = process.env.CHAT_CODE_MESSAGE;
const e2eePin = process.env.FB_E2EE_PIN;
const reminderTasksRaw = process.env.REMINDER_TASKS || '[]';
let reminderTasks = [];

/* Every reason this run did not deliver what it was asked to deliver.
   A non-empty list exits non-zero, which is what makes the GitHub run go red
   and the Automation Hub record the dispatch as failed. Before this, a run
   that found no chat box still exited 0: the dashboard showed a cheerful
   "Dispatched" for a message nobody ever received. */
const failures = [];
const fail = (reason) => {
  console.log(`❌ ${reason}`);
  failures.push(reason);
};

try {
  reminderTasks = JSON.parse(reminderTasksRaw);
} catch (e) {
  console.error("Failed to parse REMINDER_TASKS", e);
  fail(`REMINDER_TASKS was not valid JSON: ${e.message}`);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Why a chat would not open. Only ever called once something has already gone
 * wrong, so a false positive here can never abort a run that is working.
 *
 * The common cause by far is stale cookies: Facebook serves the "Continue as…"
 * profile chooser, which has no message box, and the run otherwise looks like
 * an unexplained missing selector.
 */
async function diagnosePage(page) {
    try {
        const url = page.url();
        const signals = await page.evaluate(() => {
            const text = document.body ? (document.body.innerText || '') : '';
            return {
                createAccount: /Create new account/i.test(text),
                chooser: /(Use another profile|Continue as|Log in with another account)/i.test(text),
                loginForm: Boolean(document.querySelector('input[name="pass"], input[type="password"][name]')),
                snippet: text.replace(/\s+/g, ' ').trim().slice(0, 180)
            };
        });

        if (/\/(login|checkpoint|recover)/i.test(url) || signals.createAccount || signals.chooser || signals.loginForm) {
            return 'the bot is not logged in — Facebook served a login or profile-chooser page. '
                + 'The FACEBOOK_COOKIES secret has most likely expired and needs re-exporting.';
        }
        return `page did not show a message box. URL: ${url} — page began: "${signals.snippet}"`;
    } catch (e) {
        return `page could not be inspected: ${e.message}`;
    }
}

/**
 * Did the text actually leave the composer?
 *
 * Deliberately conservative: it only reports a failure when the text that was
 * just typed is demonstrably still sitting in the box. Anything else — an
 * empty composer, a placeholder, an unreadable element — counts as sent, so a
 * delivery that worked can never be reported as broken.
 */
async function verifySent(page, chatBox, message, label) {
    try {
        const probe = (String(message).split('\n')[0] || '').trim().slice(0, 40);
        if (!probe) return true;

        const remaining = await page.evaluate(el => (el && el.innerText) || '', chatBox);
        if (remaining.includes(probe)) {
            fail(`${label}: the text was still in the message box after pressing Enter — it did not send.`);
            return false;
        }
        return true;
    } catch (e) {
        console.log(`(could not verify ${label}, assuming it sent: ${e.message})`);
        return true;
    }
}

async function typeMessage(page, message) {
    const lines = String(message).split('\n');
    for (let j = 0; j < lines.length; j++) {
        await page.keyboard.type(lines[j], { delay: 10 });
        if (j < lines.length - 1) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Shift');
        }
    }
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

    let page;

    try {
        page = await browser.newPage();

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
        if (targetUrl && targetUrl.trim() !== '' && ((targetMessage && targetMessage.trim() !== '' && targetMessage.trim() !== 'NO_MESSAGE') || (codeMessage && codeMessage.trim() !== '' && codeMessage.trim() !== 'NO_MESSAGE'))) {
            console.log(`Navigating to group chat: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(3000); // Stabilization

            // Handle E2EE Popup if it appears
            await handleE2EEPopup(page, e2eePin);

            console.log("Focusing the chat box...");
            const textBoxes = await page.$$('div[role="textbox"]');
            if (textBoxes.length > 0) {
                const chatBox = textBoxes[textBoxes.length - 1]; // Usually the last one
                await chatBox.focus();

                if (targetMessage && targetMessage.trim() !== '') {
                    console.log("Typing group message...");
                    await typeMessage(page, targetMessage);

                    await delay(1500);
                    console.log("Sending group message...");
                    await page.keyboard.press('Enter');
                    await delay(3000); // Wait for network dispatch
                    await verifySent(page, chatBox, targetMessage, 'Group message');
                }

                // If there's a separate confirmation code message, send it now
                if (codeMessage && codeMessage.trim() !== '') {
                    console.log("Typing separate code message...");
                    await typeMessage(page, codeMessage);

                    await delay(1500);
                    console.log("Sending separate code message...");
                    await page.keyboard.press('Enter');
                    await delay(3000);
                    await verifySent(page, chatBox, codeMessage, 'Code message');
                }

                console.log("✅ Successfully sent message(s) to group!");
            } else {
                fail(`Could not find the group chat text box — ${await diagnosePage(page)}`);
            }
        } else {
            console.log("⏭️ Skipping Main Group Message (Both dynamic message and code message were empty).");
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
                await delay(3000);

                await handleE2EEPopup(page, e2eePin);

                // --- CHECK CHAT HISTORY FOR CONFIRMATION CODE ---
                console.log("Scanning recent chat history for confirmation code...");
                const chatHistoryText = await page.evaluate(() => {
                    return document.body.innerText;
                });

                // An absent expectedCode must not match every chat: includes()
                // on undefined would throw, and on '' would be true for all.
                if (task.expectedCode && chatHistoryText.includes(task.expectedCode)) {
                    console.log(`✅ Member ALREADY CONFIRMED using code ${task.expectedCode}. Skipping reminder.`);
                    continue; // Skip to next task
                }

                // If not confirmed, send the reminder
                console.log(`❌ No confirmation code found. Sending nudge to member...`);
                const textBoxes = await page.$$('div[role="textbox"]');
                if (textBoxes.length > 0) {
                    const chatBox = textBoxes[textBoxes.length - 1];
                    await chatBox.click();
                    await delay(1000);

                    await typeMessage(page, task.message);

                    await delay(2000); // Give React time to recognize the text and enable the Send button

                    await page.keyboard.press('Enter');
                    await delay(15000); // 15s Network dispatch for slow proxies
                    if (await verifySent(page, chatBox, task.message, `Reminder to ${task.url}`)) {
                        console.log("✅ Sent private reminder successfully.");
                    }
                } else {
                    fail(`Could not find the private chat text box for ${task.url} — ${await diagnosePage(page)}`);
                }
            }
        }

    } catch (error) {
        console.error("Execution Error:", error);
        fail(`Execution error: ${error.message}`);
    } finally {
        // The screenshot matters most in exactly the case that used to skip it:
        // when something threw before reaching the end of the run.
        if (page) {
            try {
                await page.screenshot({ path: 'debug.png', fullPage: true });
                console.log("📸 Saved debug screenshot.");
            } catch (e) {
                console.log("Could not save debug screenshot:", e.message);
            }
        }
        await browser.close();
    }

    if (failures.length > 0) {
        console.error(`\n🚨 This run did NOT deliver everything it was asked to (${failures.length} problem(s)):`);
        failures.forEach((f, i) => console.error(`   ${i + 1}. ${f}`));
        console.error('\nThe debug screenshot artifact on this run shows what the page looked like.');
        // Non-zero so the run goes red and the Automation Hub stops recording
        // an undelivered message as a success.
        process.exitCode = 1;
        return;
    }

    console.log("\n🏁 Run complete — everything requested was delivered.");
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
            await delay(1000);

            // Press Enter to submit
            await page.keyboard.press('Enter');

            // Wait for history to load
            console.log("Waiting for chat history to decrypt and load...");
            await delay(6000);
        } else {
            console.log("🔓 No E2EE PIN Pop-up detected, or no PIN provided.");
        }
    } catch (err) {
        console.log("Error handling E2EE popup, continuing...", err.message);
    }
}

// An unhandled rejection here used to end the process without a word about
// what broke, and without a failing exit code on older Node versions.
runAutomation().catch(error => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
});
