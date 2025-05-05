const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = 3000;
const ipAddress = '0.0.0.0';

// --- Configuración ---
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const dataPath = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

// Almacenamiento
const sessions = {};
const qrCodes = {};
const sessionStatus = {};

console.log('🚀 WhatsApp Automator Server initialized');

// --- Endpoints de Gestión de Sesión ---

app.post('/start-session', express.json(), async (req, res) => {
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    console.log(`[Session] Starting new session for userId: ${userId}`);

    if (sessions[userId] && (sessionStatus[userId] === 'ready' || sessionStatus[userId] === 'initializing' || sessionStatus[userId] === 'needs_scan' || sessionStatus[userId] === 'authenticated')) {
        return res.json({ success: true, message: `Session already ${sessionStatus[userId]}`, status: sessionStatus[userId] });
    }

    if (sessions[userId]) {
        console.log(`[Session] Cleaning up previous session for ${userId}`);
        try {
            if (sessions[userId].pupPage) {
               sessions[userId].destroy().catch(err => console.warn(`[Session] Error during cleanup for ${userId}: ${err.message}`));
            }
        } catch (err) {
            console.warn(`[Session] Error during cleanup check for ${userId}: ${err.message}`);
        }
        delete sessions[userId];
        delete qrCodes[userId];
    }

    sessionStatus[userId] = 'initializing';
    qrCodes[userId] = null;

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId, dataPath: dataPath }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--log-level=3', 
                '--no-default-browser-check',
                '--disable-extensions',
                '--disable-background-networking',
                '--enable-features=NetworkService,NetworkServiceInProcess',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-features=TranslateUI',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--no-first-run',
                '--password-store=basic',
                '--use-mock-keychain',
            ],
        },
         webVersionCache: {
           type: 'local',
           path: path.join(__dirname, `.wwebjs_cache_${userId}`),
         }
    });

    sessions[userId] = client;

    client.on('qr', (qr) => {
        console.log(`[Session] QR Code generated for ${userId}`);
        qrCodes[userId] = qr;
        sessionStatus[userId] = 'needs_scan';
    });

    client.on('ready', () => {
        console.log(`[Session] ✅ WhatsApp client ready for ${userId}`);
        sessionStatus[userId] = 'ready';
        qrCodes[userId] = null; 
    });

    client.on('authenticated', () => {
        console.log(`[Session] Client authenticated for ${userId}`);
        sessionStatus[userId] = 'authenticated'; 
        qrCodes[userId] = null; 
    });

    client.on('auth_failure', msg => {
        console.error(`[Session] ❌ Authentication failed for ${userId}:`, msg);
        sessionStatus[userId] = 'auth_failure';
        const clientToDestroy = sessions[userId];
        delete sessions[userId];
        delete qrCodes[userId];
        if (clientToDestroy) clientToDestroy.destroy().catch(e => console.error("[Session] Error destroying on auth_failure", e));
        const sessionFolderPath = path.join(dataPath, `session-${userId}`);
        fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
            if (err) console.error(`[Session] Error removing session folder for ${userId}:`, err);
        });
    });

    client.on('disconnected', (reason) => {
        console.warn(`[Session] 🔌 Client disconnected for ${userId}:`, reason);
        sessionStatus[userId] = 'disconnected';
        const clientToDestroy = sessions[userId];
        delete sessions[userId];
        delete qrCodes[userId];
        if (clientToDestroy) {
            clientToDestroy.destroy().catch(e => console.error("[Session] Error destroying on disconnect", e));
        }
    });

    try {
        await client.initialize();
        res.json({ success: true, message: 'Session initialization finished.', status: sessionStatus[userId] });
    } catch (err) {
        console.error(`[Session] ❌ Error initializing client for ${userId}:`, err);
        sessionStatus[userId] = 'init_error';
        const clientToDestroy = sessions[userId];
        delete sessions[userId];
        delete qrCodes[userId];
        if(clientToDestroy) clientToDestroy.destroy().catch(e => console.error("[Session] Error destroying failed client", e));
        res.status(500).json({ success: false, error: `Failed to initialize session: ${err.message}`, status: 'init_error' });
    }
});

app.get('/session-status/:userId', async (req, res) => {
    const userId = req.params.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const client = sessions[userId];
    const trackedStatus = sessionStatus[userId] || 'no_session';

    if (client && typeof client.getState === 'function') {
        try {
            const state = await client.getState();
            console.log(`   Client state for ${userId}: ${state}`);

            if (state === 'CONNECTED') {
                if (trackedStatus !== 'ready') console.log(`   Updating tracked status to 'ready' for ${userId}`);
                sessionStatus[userId] = 'ready';
                qrCodes[userId] = null;
                return res.json({ success: true, status: 'ready' });
            } else if (state === 'PAIRING') {
                 if (trackedStatus !== 'needs_scan') console.log(`   Updating tracked status to 'needs_scan' for ${userId}`);
                sessionStatus[userId] = 'needs_scan';
                return res.json({ success: true, status: 'needs_scan' });
            } else if (state === null || state === 'OPENING' || state === 'TIMEOUT') {
                if (trackedStatus === 'initializing' || trackedStatus === 'authenticated' || trackedStatus === 'needs_scan') {
                    console.log(`   getState is '${state}', but tracked status is '${trackedStatus}'. Responding with tracked status.`);
                    return res.json({ success: true, status: trackedStatus });
                } else {
                    console.warn(`   Handling intermediate state for ${userId}: getState is '${state}', tracked status was '${trackedStatus}'. Setting to 'initializing'.`);
                    sessionStatus[userId] = 'initializing';
                    return res.json({ success: true, status: 'initializing' });
                }
            } else {
                console.warn(`   Unhandled client state '${state}' for ${userId}. Setting to 'disconnected'.`);
                 if (trackedStatus !== 'disconnected' && trackedStatus !== 'no_session') {
                     const clientToDestroy = sessions[userId];
                     delete sessions[userId];
                     delete qrCodes[userId];
                      if (clientToDestroy) clientToDestroy.destroy().catch(e => console.error("Error destroying on unhandled state", e));
                 }
                sessionStatus[userId] = 'disconnected';
                return res.json({ success: true, status: 'disconnected' });
            }

        } catch (err) {
            console.error(`   Error getting client state for ${userId}:`, err);
            return res.json({ success: true, status: trackedStatus, error: 'Could not determine exact client state.' });
        }
    } else {
        console.log(`   No client instance found for ${userId}. Responding with tracked status: ${trackedStatus}`);
        return res.json({ success: true, status: trackedStatus });
    }
});

app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    const qr = qrCodes[userId];
    const status = sessionStatus[userId];

    if (status === 'ready') {
        console.log(`<- Responding QR: Session ready for ${userId}`);
        return res.json({ success: true, qrCode: null, status: 'ready', message: 'Client already ready' });
    } else if (qr && status === 'needs_scan') {
        console.log(`<- Responding QR: Sending QR code for ${userId}`);
        return res.json({ success: true, qrCode: qr, status: 'needs_scan' });
    } else if (status === 'initializing' || status === 'authenticated') {
        if(qr && status === 'authenticated') {
             console.log(`<- Responding QR: Sending QR code for authenticated user ${userId}`);
             return res.json({ success: true, qrCode: qr, status: 'authenticated' });
        }
        console.log(`<- Responding QR: Not generated yet or already authenticated (no QR) for ${userId} (Status: ${status})`);
        return res.status(202).json({ success: false, status: status, error: 'QR code not generated yet or session is authenticating/ready.' });
    } else {
        console.log(`<- Responding QR: No active session or QR for userId: ${userId}, Status: ${status}`);
        return res.status(404).json({ success: false, status: status || 'no_session', error: 'No session found, QR not generated, session error, or disconnected.' });
    }
});

app.post('/close-session', express.json(), async (req, res) => {
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    console.log(`>>> POST /close-session request for userId: ${userId}`);
    const client = sessions[userId];

    if (client) {
        const currentStatus = sessionStatus[userId];
        console.log(`   Closing session for ${userId}. Current status: ${currentStatus}`);
        sessionStatus[userId] = 'disconnected';
        delete qrCodes[userId];

        try {
             if (currentStatus === 'ready' || currentStatus === 'authenticated') {
                 await client.logout();
                 console.log(`   Client logout successful for ${userId}`);
             } else {
                 console.log(`   Skipping logout for ${userId} as status was ${currentStatus}`);
             }
        } catch (err) {
            console.error(`   Error during logout for ${userId} (continuing cleanup):`, err.message);
        } finally {
             try {
                 if (sessions[userId] && typeof sessions[userId].destroy === 'function') {
                     await sessions[userId].destroy();
                     console.log(`   Client instance destroyed for ${userId}`);
                 }
             } catch (destroyError) {
                 console.error(`   Error destroying client for ${userId} during close:`, destroyError);
             } finally {
                 delete sessions[userId];
                 sessionStatus[userId] = 'no_session';
                 const sessionFolderPath = path.join(dataPath, `session-${userId}`);
                 fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
                     if (err) console.error(`   Error removing session folder for ${userId}:`, err);
                     else console.log(`   Removed session folder for ${userId}`);
                 });
             }
        }
        res.json({ success: true, message: 'Session closed successfully.', status: 'no_session' });
    } else {
        console.log(`   No active session found to close for userId: ${userId}`);
        sessionStatus[userId] = 'no_session';
        res.status(404).json({ success: false, error: 'No active session found.', status: 'no_session' });
    }
});

app.get('/labels/:userId', async (req, res) => {
    const userId = req.params.userId;
    const client = sessions[userId];

    if (!client || sessionStatus[userId] !== 'ready') {
        console.warn(`Session not ready for labels request (userId: ${userId}) - Status: ${sessionStatus[userId]}`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
    }

    try {
        if (typeof client.getLabels !== 'function') {
             console.warn(`client.getLabels is not a function for userId: ${userId}.`);
             return res.status(501).json({ success: false, error: 'Fetching labels is likely not supported for this account.' });
        }
        const labels = await client.getLabels();
        return res.json({ success: true, labels: labels });
    } catch (error) {
        console.error(`Error fetching labels for ${userId}:`, error);
         if (error.message.includes("Evaluation failed") || error.message.includes("window.WWebJS.getLabels is not a function")) {
             res.status(501).json({ success: false, error: 'Failed to fetch labels. This feature might require a WhatsApp Business account.' });
         } else {
             res.status(500).json({ success: false, error: 'Failed to fetch labels: ' + error.message });
         }
    }
});

app.get('/labels/:userId/:labelId/chats', async (req, res) => {
    const { userId, labelId } = req.params;
    const client = sessions[userId];

    if (!client || sessionStatus[userId] !== 'ready') {
        console.warn(`Session not ready for label chats request (userId: ${userId}) - Status: ${sessionStatus[userId]}`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
    }

    try {
         if (typeof client.getChatsByLabelId !== 'function') {
             console.warn(`client.getChatsByLabelId is not a function for userId: ${userId}.`);
             return res.status(501).json({ success: false, error: 'Fetching chats by label is likely not supported for this account.' });
         }
        const chats = await client.getChatsByLabelId(labelId);
        const numbers = chats.map(chat => chat.id.user);

        console.log(`<- Responding: Chats fetched for label ${labelId}: ${numbers.length}`);
        res.json({ success: true, numbers: numbers });
    } catch (error) {
        console.error(`Error fetching chats for label ${labelId}, userId: ${userId}:`, error);
        if (error.message.includes("Evaluation failed") || error.message.includes("getChatsByLabelId is not a function")) {
             res.status(501).json({ success: false, error: 'Fetching chats by label might require WhatsApp Business or is not supported by this version.' });
        } else {
             res.status(500).json({ success: false, error: 'Failed to fetch chats for the label: ' + error.message });
        }
    }
});

app.get('/groups/:userId', async (req, res) => {
    const userId = req.params.userId;
     console.log(`>>> GET /groups/${userId} request`);
     const client = sessions[userId];

     if (!client || sessionStatus[userId] !== 'ready') {
          console.warn(`Session not ready for groups request (userId: ${userId})`);
         return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
     }

     try {
         const chats = await client.getChats();
         const groups = chats
            .filter(chat => chat.isGroup)
             .map(chat => ({
                 id: chat.id._serialized,
                 name: chat.name || 'Grupo sin nombre',
             }));
         console.log(`<- Responding: Groups fetched for ${userId}:`, groups.length);
         res.json({ success: true, groups: groups });
     } catch (error) {
         console.error(`Error fetching groups for ${userId}:`, error);
         res.status(500).json({ success: false, error: 'Failed to fetch groups: ' + error.message });
     }
});

app.get('/groups/:userId/:groupId/participants', async (req, res) => {
    const { userId, groupId } = req.params;
    console.log(`>>> GET /groups/${userId}/${groupId}/participants request`);
    const client = sessions[userId];

    if (!client || sessionStatus[userId] !== 'ready') {
        console.warn(`Session not ready for group participants request (userId: ${userId})`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
    }

    try {
        const groupChat = await client.getChatById(groupId);

        if (!groupChat || !groupChat.isGroup) {
             console.warn(`<- Responding: Group not found for ${groupId}`);
            return res.status(404).json({ success: false, error: 'Group not found.' });
        }
        let participants = [];
        if (groupChat.participants && Array.isArray(groupChat.participants)) {
            participants = groupChat.participants;
        } else if (typeof groupChat.fetchParticipants === 'function') {
            try {
                 console.log(`   Fetching participants for group ${groupId}...`);
                 participants = await groupChat.fetchParticipants();
                 console.log(`   Fetched ${participants.length} participants for group ${groupId}`);
            } catch(fetchErr) {
                 console.error(`   Error fetching participants explicitly for ${groupId}:`, fetchErr);
                
            }
        }

        const numbers = participants.map(p => p.id.user);

        console.log(`<- Responding: Participants fetched for group ${groupId}: ${numbers.length}`);
        res.json({ success: true, numbers: numbers });
    } catch (error) {
        console.error(`Error fetching participants for group ${groupId}, userId: ${userId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to fetch participants: ' + error.message });
    }
});

app.post('/send-messages', upload.single('media'), async (req, res) => {
    const { userId, message, delay, numbers: numbersJson, mensajesPorNumero: mensajesJson } = req.body;
    const mediaFile = req.file; 

    console.log(`[Messages] Starting message send process for userId: ${userId}`);

    if (!userId) {
        if (mediaFile) fs.unlinkSync(mediaFile.path);
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const client = sessions[userId];
    if (!client || sessionStatus[userId] !== 'ready') {
        if (mediaFile) fs.unlinkSync(mediaFile.path);
        console.error(`[Messages] Session not ready for userId: ${userId}. Status: ${sessionStatus[userId]}`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.', status: sessionStatus[userId] });
    }

    let numbersRaw;
    let mensajesPorNumero;
    try {
        numbersRaw = JSON.parse(numbersJson || '[]');
        mensajesPorNumero = JSON.parse(mensajesJson || '[]');
        if (!Array.isArray(numbersRaw)) throw new Error("Invalid 'numbers' array.");
        if (!Array.isArray(mensajesPorNumero)) mensajesPorNumero = numbersRaw.map(() => message || "");
        if (mensajesPorNumero.length !== numbersRaw.length) {
             console.warn("   Length mismatch between numbers and messages, using default message for missing ones.");
             mensajesPorNumero = numbersRaw.map((_, index) => mensajesPorNumero[index] || message || "");
        }

    } catch (e) {
        if (mediaFile) fs.unlinkSync(mediaFile.path);
        console.error(`   Error parsing numbers/messages JSON for userId ${userId}:`, e);
        return res.status(400).json({ success: false, error: 'Invalid JSON in numbers or mensajesPorNumero field.' });
    }

     if (!message && !mediaFile) {
         return res.status(400).json({ success: false, error: 'Message or media file is required.' });
     }
    if (numbersRaw.length === 0) {
        if (mediaFile) fs.unlinkSync(mediaFile.path);
        return res.status(400).json({ success: false, error: 'No numbers selected to send to.' });
    }

    const sendDelay = parseInt(delay, 10) || 8000;
    let media = null;

    if (mediaFile) {
        try {
            const fileContent = fs.readFileSync(mediaFile.path);
            media = new MessageMedia(
                mediaFile.mimetype, 
                fileContent.toString('base64'),
                mediaFile.originalname 
            );
            console.log(`[Messages] Media file processed: ${mediaFile.originalname}`);
        } catch (mediaError) {
            console.error(`[Messages] Error processing media file:`, mediaError);
            fs.unlink(mediaFile.path, (err) => {
                if (err) console.error(`[Messages] Error deleting failed media file:`, err);
            });
            media = null;
        }
    }

    let enviados = 0;
    let fallidos = 0;
    const total = numbersRaw.length;
    const failedNumbers = [];
    const sendPromises = [];

    console.log(`[Messages] Starting to send ${total} messages with delay ${sendDelay}ms`);

    res.json({
        success: true,
        message: `Message sending process initiated for ${total} numbers.`,
        summary: { enviados: 0, fallidos: 0, total },
    });

    (async () => {
        for (let i = 0; i < numbersRaw.length; i++) {
            const originalNumber = numbersRaw[i];
            const currentMessage = mensajesPorNumero[i] || message || "";
            let numberOnly = originalNumber.replace(/\D/g, '');

            if (!originalNumber.includes('+') && numberOnly.length === 8 && !numberOnly.startsWith('591')) {
                numberOnly = '591' + numberOnly;
            } else if (originalNumber.includes('+')) {
                numberOnly = originalNumber.replace(/\D/g, '');
            }

            let recipientWID = null;
            let chatId = null;
            let sendPromise = null;

            try {
                recipientWID = await client.getNumberId(numberOnly);

                if (recipientWID) {
                    chatId = recipientWID._serialized;
                    
                    if (media) {
                        sendPromise = client.sendMessage(chatId, media, { caption: currentMessage || undefined })
                            .then(() => { console.log(`[Messages] ✅ Media sent to ${numberOnly}`); })
                            .catch(err => {
                                console.error(`[Messages] ❌ Failed sending media to ${numberOnly}:`, err.message);
                                failedNumbers.push({ number: originalNumber, reason: err.message || 'Send media failed' });
                                return Promise.reject(err);
                            });
                    } else if (currentMessage) {
                        sendPromise = client.sendMessage(chatId, currentMessage)
                            .then(() => { console.log(`[Messages] ✅ Message sent to ${numberOnly}`); })
                            .catch(err => {
                                console.error(`[Messages] ❌ Failed sending message to ${numberOnly}:`, err.message);
                                failedNumbers.push({ number: originalNumber, reason: err.message || 'Send message failed' });
                                return Promise.reject(err);
                            });
                    } else {
                        console.warn(`[Messages] Skipping ${numberOnly}: No content`);
                        failedNumbers.push({ number: originalNumber, reason: "No content" });
                        sendPromise = Promise.reject(new Error("No content to send"));
                    }
                } else {
                    console.warn(`[Messages] Number ${numberOnly} is not registered`);
                    failedNumbers.push({ number: originalNumber, reason: "Not a valid WhatsApp number" });
                    sendPromise = Promise.reject(new Error("Not a valid WhatsApp number"));
                }
            } catch (err) {
                console.error(`[Messages] Error processing ${numberOnly}:`, err.message);
                failedNumbers.push({ number: originalNumber, chatIdAttempted: chatId, reason: err.message || 'Error during number check/send setup' });
                sendPromise = Promise.reject(err);
            }

            sendPromises.push(sendPromise || Promise.resolve());

            if (i < numbersRaw.length - 1) {
                await new Promise(resolve => setTimeout(resolve, sendDelay));
            }
        }

        const results = await Promise.allSettled(sendPromises);
        enviados = results.filter(r => r.status === 'fulfilled').length;
        fallidos = total - enviados;

        console.log(`[Messages] ✅ Finished sending process. Sent: ${enviados}, Failed: ${fallidos}`);
        if (failedNumbers.length > 0) {
            console.warn("[Messages] Failed numbers:", failedNumbers);
        }

        if (mediaFile) {
            fs.unlink(mediaFile.path, (err) => {
                if (err) console.error(`[Messages] Error deleting uploaded file:`, err);
            });
        }
    })();
});

app.get('/reports/:userId/:labelId/messages', async (req, res) => {
    const { userId, labelId } = req.params;
    console.log(`>>> GET /reports/${userId}/${labelId}/messages request`);
    const client = sessions[userId];

    if (!client || sessionStatus[userId] !== 'ready') {
        console.warn(`Session not ready for reports request (userId: ${userId})`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
    }

    try {
        console.warn(`   Report data generation for label ${labelId} for user ${userId} - Implementation pending`);

        let reportMessages = [];
         if (typeof client.getChatsByLabelId === 'function') {
            const chats = await client.getChatsByLabelId(labelId);
             for (const chat of chats) {
                 try {
                     const messages = await chat.fetchMessages({ limit: 10 });
                     messages.forEach(msg => {
                         if (msg.fromMe) {
                             reportMessages.push({
                                 number: chat.id.user,
                                 body: msg.body || (msg.hasMedia ? '[Media]' : ''),
                                 timestamp: msg.timestamp,
                                 ack: msg.ack,
                                 response: null 
                             });
                         }
                     });
                 } catch (chatErr) {
                     console.error(`   Error fetching messages for chat ${chat.id._serialized}:`, chatErr);
                 }
             }
         } else {
            console.warn("   getChatsByLabelId not available for reports.");
         }

        console.log(`<- Responding: Report data for label ${labelId} (Messages: ${reportMessages.length})`);
        res.json({ success: true, messages: reportMessages });

    } catch (error) {
        console.error(`Error generating report for label ${labelId}, userId: ${userId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to generate report: ' + error.message });
    }
});

app.listen(port, ipAddress, () => {
    console.log(`🚀 WhatsApp Automator Server running at http://${ipAddress}:${port}`);
});