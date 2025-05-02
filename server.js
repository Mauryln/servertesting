// server.js
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); // Para mostrar QR en terminal (opcional)
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// --- Configuración ---
// Habilita CORS para permitir peticiones desde la extensión Chrome
app.use(cors());
// Middleware para parsear JSON en el cuerpo de las peticiones POST
app.use(express.json());
// Configura Multer para manejar la subida de archivos (para adjuntos)
const upload = multer({ dest: 'uploads/' }); // Directorio temporal para adjuntos

// Asegura que el directorio de uploads exista
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
    console.log(`📁 Directorio de uploads creado en ${uploadsDir}`);
}
// Asegura que el directorio de datos de sesión exista
const dataPath = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
    console.log(`📁 Directorio de datos de sesión creado en ${dataPath}`);
}

// Almacenamiento en memoria para sesiones, QR y estados (mejorar para producción)
const sessions = {};
const qrCodes = {};
const sessionStatus = {}; // Estados: 'initializing', 'needs_scan', 'ready', 'auth_failure', 'disconnected', 'no_session', 'init_error'

console.log('Initializing WhatsApp Automator Server...');

// --- Endpoints de Gestión de Sesión ---

app.post('/start-session', express.json(), async (req, res) => {
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    console.log(`Starting session request for userId: ${userId}`);

    if (sessions[userId] && sessionStatus[userId] === 'ready') {
        console.log(`Session already active for userId: ${userId}`);
        return res.json({ success: true, message: 'Session already active', status: 'ready' });
    }
    if (sessions[userId] && (sessionStatus[userId] === 'initializing' || sessionStatus[userId] === 'needs_scan')) {
        console.log(`Session already initializing for userId: ${userId}`);
        return res.json({ success: true, message: 'Session already initializing', status: sessionStatus[userId] });
    }
     // Si hay un cliente previo en estado erróneo, intentar limpiarlo antes de crear uno nuevo
     if (sessions[userId]) {
         console.log(`Cleaning up previous stale session for ${userId}...`);
         try {
             await sessions[userId].destroy();
         } catch (err) { /* Ignorar errores al destruir */ }
         delete sessions[userId];
         delete qrCodes[userId];
         // Podrías borrar la carpeta de sesión aquí también si quieres forzar una nueva autenticación
     }

    sessionStatus[userId] = 'initializing';
    qrCodes[userId] = null;

    console.log(`Creating new WhatsApp client for userId: ${userId}`);
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
                '--disable-gpu'
             ],
             // executablePath: '/usr/bin/google-chrome-stable', // Descomentar y ajustar si es necesario
        },
        webVersionCache: {
           type: 'local',
           path: path.join(__dirname, `.wwebjs_cache_${userId}`),
         }
    });

    client.on('qr', (qr) => {
        console.log(`QR Code generated for ${userId}. Scan it.`);
        qrCodes[userId] = qr;
        sessionStatus[userId] = 'needs_scan';
        // qrcode.generate(qr, { small: true }); // Descomentar para ver QR en terminal
    });

    client.on('ready', () => {
        console.log(`✅ WhatsApp client is ready for ${userId}!`);
        sessionStatus[userId] = 'ready';
        qrCodes[userId] = null;
    });

    client.on('authenticated', () => {
        console.log(`Client authenticated for ${userId}`);
        sessionStatus[userId] = 'authenticated';
    });

    client.on('auth_failure', msg => {
        console.error(`❌ Authentication failure for ${userId}:`, msg);
        sessionStatus[userId] = 'auth_failure';
        delete sessions[userId];
        delete qrCodes[userId];
        // Considerar limpiar la carpeta de sesión
        const sessionFolderPath = path.join(dataPath, `session-${userId}`);
        fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
            if (err) console.error(`Error removing session folder on auth_failure for ${userId}:`, err);
            else console.log(`Removed session folder on auth_failure for ${userId}`);
        });
    });

    client.on('disconnected', (reason) => {
        console.warn(`🔌 Client was logged out for ${userId}:`, reason);
        sessionStatus[userId] = 'disconnected';
         try {
            // Intentar destruir explícitamente aunque ya esté desconectado
             if (sessions[userId] && typeof sessions[userId].destroy === 'function') {
                 sessions[userId].destroy();
                 console.log(`Client instance destroyed after disconnect for ${userId}`);
             }
         } catch (destroyError) {
             console.error(`Error destroying client after disconnect for ${userId}:`, destroyError);
         } finally {
             delete sessions[userId];
             delete qrCodes[userId];
             // Limpiar carpeta de sesión al desconectar
             const sessionFolderPath = path.join(dataPath, `session-${userId}`);
             fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
                 if (err) console.error(`Error removing session folder on disconnect for ${userId}:`, err);
                 else console.log(`Removed session folder on disconnect for ${userId}`);
             });
         }
    });

    client.initialize().catch(err => {
        console.error(`❌ Error initializing client for ${userId}:`, err);
        if (sessionStatus[userId] !== 'ready' && sessionStatus[userId] !== 'disconnected') {
           sessionStatus[userId] = 'init_error';
        }
        delete sessions[userId];
        delete qrCodes[userId];
    });

    sessions[userId] = client;
    res.json({ success: true, message: 'Session initialization started.', status: sessionStatus[userId] });
});

app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    const qr = qrCodes[userId];
    const status = sessionStatus[userId];

    if (status === 'ready') {
        return res.json({ success: true, qrCode: null, status: 'ready', message: 'Client already ready' });
    } else if (qr) {
        return res.json({ success: true, qrCode: qr, status: 'needs_scan' });
    } else if (status === 'initializing' || status === 'authenticated') { // Incluir authenticated aquí
        return res.status(202).json({ success: false, status: status, error: 'QR code not generated yet or already authenticated.' });
    } else {
        console.log(`No active session or QR found for userId: ${userId}, Status: ${status}`);
        return res.status(404).json({ success: false, status: status || 'no_session', error: 'No session found or QR not generated.' });
    }
});

app.get('/session-status/:userId', async (req, res) => {
    const userId = req.params.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const client = sessions[userId];
    const trackedStatus = sessionStatus[userId] || 'no_session';

    console.log(`Checking status for ${userId}. Tracked status: ${trackedStatus}`);

    if (client && typeof client.getState === 'function') {
        try {
            const state = await client.getState();
            console.log(`Client state for ${userId}: ${state}`);
            if (state === 'CONNECTED') {
                sessionStatus[userId] = 'ready';
                return res.json({ success: true, status: 'ready' });
            } else if (state === 'PAIRING') {
                sessionStatus[userId] = 'needs_scan';
                return res.json({ success: true, status: 'needs_scan' });
            } else if (state === null && trackedStatus === 'initializing') {
                // Still starting up, puppeteer might not be fully ready
                 return res.json({ success: true, status: 'initializing' });
            } else if (state === null && trackedStatus === 'disconnected') {
                 sessionStatus[userId] = 'no_session';
                 return res.json({ success: true, status: 'no_session' });
            }
            // Fallback for other states (OPENING, TIMEOUT etc.) - rely on tracked status or assume initializing/needs_scan if appropriate
            if (trackedStatus === 'initializing' || trackedStatus === 'needs_scan' || trackedStatus === 'authenticated') {
                 return res.json({ success: true, status: trackedStatus });
            }
             sessionStatus[userId] = 'disconnected'; // Assume disconnected otherwise
             return res.json({ success: true, status: 'disconnected' });

        } catch (err) {
            console.error(`Error getting client state for ${userId}:`, err);
            // If getState fails, rely on tracked status, or mark as no_session if appropriate
            if (trackedStatus === 'initializing' || trackedStatus === 'needs_scan' || trackedStatus === 'authenticated') {
                return res.json({ success: true, status: trackedStatus });
            } else {
                 sessionStatus[userId] = 'no_session'; // Reset if error and not initializing/scanning
                 return res.json({ success: true, status: 'no_session', error: 'Could not determine client state.' });
            }
        }
    } else {
        // No client instance, return the tracked status
        return res.json({ success: true, status: trackedStatus });
    }
});

app.post('/close-session', express.json(), async (req, res) => {
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    console.log(`Closing session request for userId: ${userId}`);
    const client = sessions[userId];

    if (client) {
        try {
            await client.logout();
            console.log(`Client logout initiated for ${userId}`);
            // Give some time for disconnect event before destroying
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            console.error(`Error during logout for ${userId}:`, err.message);
        } finally {
             try {
                 if (sessions[userId] && typeof sessions[userId].destroy === 'function') {
                     await sessions[userId].destroy();
                     console.log(`Client instance destroyed for ${userId}`);
                 }
             } catch (destroyError) {
                 console.error(`Error destroying client for ${userId}:`, destroyError);
             } finally {
                 delete sessions[userId];
                 delete qrCodes[userId];
                 sessionStatus[userId] = 'no_session';
                 const sessionFolderPath = path.join(dataPath, `session-${userId}`);
                 fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
                     if (err) console.error(`Error removing session folder for ${userId}:`, err);
                     else console.log(`Removed session folder for ${userId}`);
                 });
             }
        }
        res.json({ success: true, message: 'Session closed successfully.' });
    } else {
        console.log(`No active session found to close for userId: ${userId}`);
        sessionStatus[userId] = 'no_session';
        res.status(404).json({ success: false, error: 'No active session found.' });
    }
});

// --- Endpoints de Obtención de Datos ---

console.log(">>> Registrando ruta /labels/:userId...");
app.get('/labels/:userId', async (req, res) => {
    const userId = req.params.userId;
    console.log(`>>> RUTA /labels/${userId} ALCANZADA`);
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
        console.log(`Labels fetched successfully for ${userId}:`, labels.length);
        // Devolver la estructura completa, como en index.js funcional
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

console.log(">>> Registrando ruta /labels/:userId/:labelId/chats...");
app.get('/labels/:userId/:labelId/chats', async (req, res) => {
    const { userId, labelId } = req.params;
    console.log(`>>> RUTA /labels/<span class="math-inline">\{userId\}/</span>{labelId}/chats ALCANZADA`);
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
        const numbers = chats.map(chat => chat.id.user); // Extraer número sin @c.us

        console.log(`Chats fetched for label ${labelId}: ${numbers.length}`);
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

console.log(">>> Registrando ruta /groups/:userId...");
app.get('/groups/:userId', async (req, res) => {
     const userId = req.params.userId;
     console.log(`>>> RUTA /groups/${userId} ALCANZADA`);
     const client = sessions[userId];

     if (!client || sessionStatus[userId] !== 'ready') {
          console.warn(`Session not ready for groups request (userId: ${userId})`);
         return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
     }

     try {
         const chats = await client.getChats();
         const groups = chats
            .filter(chat => chat.isGroup)
             .map(chat => {
                 // Intentar obtener participantes directamente si es posible y rápido
                 // let participantCount = chat.participants ? chat.participants.length : 'N/A';
                 // Nota: Acceder a chat.participants puede ser lento si hay muchos grupos.
                 // Considera devolver solo nombre e id inicialmente, y obtener participantes bajo demanda.
                 return {
                     id: chat.id._serialized,
                     name: chat.name || 'Grupo sin nombre',
                     // participants: participantCount // Descomentar con precaución
                 };
             });
         console.log(`Groups fetched for ${userId}:`, groups.length);
         res.json({ success: true, groups: groups });
     } catch (error) {
         console.error(`Error fetching groups for ${userId}:`, error);
         res.status(500).json({ success: false, error: 'Failed to fetch groups: ' + error.message });
     }
});

console.log(">>> Registrando ruta /groups/:userId/:groupId/participants...");
app.get('/groups/:userId/:groupId/participants', async (req, res) => {
    const { userId, groupId } = req.params;
    console.log(`>>> RUTA /groups/<span class="math-inline">\{userId\}/</span>{groupId}/participants ALCANZADA`);
    const client = sessions[userId];

    if (!client || sessionStatus[userId] !== 'ready') {
        console.warn(`Session not ready for group participants request (userId: ${userId})`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
    }

    try {
        // getChatById puede ser más eficiente si tienes el ID serializado
        const groupChat = await client.getChatById(groupId);

        if (!groupChat || !groupChat.isGroup) {
            return res.status(404).json({ success: false, error: 'Group not found.' });
        }

        const participants = groupChat.participants;
        // Extraer solo los números (sin el @c.us)
        const numbers = participants.map(p => p.id.user);

        console.log(`Participants fetched for group ${groupId}: ${numbers.length}`);
        res.json({ success: true, numbers: numbers });
    } catch (error) {
        console.error(`Error fetching participants for group ${groupId}, userId: ${userId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to fetch participants: ' + error.message });
    }
});

// --- Endpoint de Envío de Mensajes ---

// Función robusta para limpiar y validar números
function sanitizeNumber(number) {
    if (!number || typeof number !== 'string') return null;
    let cleaned = number.replace(/\D/g, ''); // Quitar no-dígitos
    let needsPlus = !number.startsWith('+');

    // Lógica específica para Bolivia (código 591, 8 dígitos)
    if (cleaned.length === 8 && !cleaned.startsWith('591')) {
        cleaned = '591' + cleaned;
        needsPlus = true; // Si asumimos 591, necesita el '+'
    } else if (cleaned.startsWith('591') && cleaned.length === 11) {
         needsPlus = true; // Si ya tiene 591 y longitud correcta, necesita '+'
    } else if (cleaned.length < 10) { // Longitud mínima general (ajustar si es necesario)
         return null;
    }

    const finalNumber = needsPlus ? ('+' + cleaned) : number; // Usa el número original si ya tenía '+'

    // Limpiar de nuevo por si acaso y añadir sufijo
    return finalNumber.replace(/\D/g, '') + '@c.us';
}


app.post('/send-messages', upload.single('media'), async (req, res) => {
    const { userId, message, delay, numbers: numbersJson, mensajesPorNumero: mensajesJson } = req.body;
    const mediaFile = req.file; // Archivo subido por Multer

    console.log(`>>> POST /send-messages request for userId: ${userId}`);

    if (!userId) {
        if (mediaFile) fs.unlinkSync(mediaFile.path);
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const client = sessions[userId];
    if (!client || sessionStatus[userId] !== 'ready') {
        if (mediaFile) fs.unlinkSync(mediaFile.path);
        console.error(`   Session not ready for userId: ${userId}. Status: ${sessionStatus[userId]}`);
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
            console.log(`   Processing media file: ${mediaFile.originalname} (MIME: ${mediaFile.mimetype}, Path: ${mediaFile.path})`);

            // 1. Leer el contenido del archivo temporal
            const fileContent = fs.readFileSync(mediaFile.path);

            // 2. Crear MessageMedia explícitamente con mimetype y contenido base64
            media = new MessageMedia(
                mediaFile.mimetype, // <-- Usar el mimetype detectado por multer
                fileContent.toString('base64'), // <-- Contenido del archivo en base64
                mediaFile.originalname // <-- Usar el nombre original
            );
            console.log(`   Created MessageMedia object successfully for ${mediaFile.originalname}`);

            // **NO BORRAR EL ARCHIVO TEMPORAL AQUÍ** - Se borrará al final
        } catch (mediaError) {
            console.error(`   Error loading/processing media file for userId ${userId}:`, mediaError);
            // Intentar borrar el archivo temporal incluso si hubo error al leerlo/procesarlo
            fs.unlink(mediaFile.path, (err) => {
                if (err) console.error(`   Error deleting failed media file ${mediaFile.path}:`, err);
            });
            // Decidir si continuar sin media o fallar. Por ahora, continuamos sin media.
            media = null; // Asegurarse que media es null si falla
            // Podrías devolver un error aquí si el adjunto es crucial:
            // return res.status(500).json({ success: false, error: 'Failed to process media file.' });
        }
    }

    let enviados = 0;
    let fallidos = 0;
    const total = numbersRaw.length;
    const failedNumbers = [];
    const sendPromises = [];

    console.log(`   Starting to send ${total} messages for ${userId} with delay ${sendDelay}ms`);

    // Respuesta inmediata
     res.json({
         success: true,
         message: `Message sending process initiated for ${total} numbers.`,
         summary: { enviados: 0, fallidos: 0, total },
     });


    // Proceso en segundo plano
    (async () => {
        for (let i = 0; i < numbersRaw.length; i++) {
            // ... (lógica para obtener chatId, etc. - SIN CAMBIOS) ...
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
                 console.log(`   (${i+1}/${total}) Checking number: ${numberOnly} (from ${originalNumber})...`);
                 recipientWID = await client.getNumberId(numberOnly);

                 if (recipientWID) {
                     chatId = recipientWID._serialized;
                     console.log(`   (${i+1}/${total}) Number ${numberOnly} is valid. WID: ${chatId}`);
                     console.log(`   (${i+1}/${total}) Queueing send to ${chatId}...`);

                     // *** Usa la variable 'media' que preparamos antes ***
                     if (media) {
                         sendPromise = client.sendMessage(chatId, media, { caption: currentMessage || undefined })
                            .then(() => { console.log(`   (${i+1}/${total}) ✅ Media sent to ${chatId}`); })
                            .catch(err => {
                                 console.error(`   (${i+1}/${total}) ❌ Failed sending media to ${chatId}:`, err.message);
                                 failedNumbers.push({ number: originalNumber, reason: err.message || 'Send media failed' });
                                 return Promise.reject(err); // Rechazar para allSettled
                             });
                     } else if (currentMessage) {
                         sendPromise = client.sendMessage(chatId, currentMessage)
                             .then(() => { console.log(`   (${i+1}/${total}) ✅ Message sent to ${chatId}`); })
                             .catch(err => {
                                 console.error(`   (${i+1}/${total}) ❌ Failed sending message to ${chatId}:`, err.message);
                                 failedNumbers.push({ number: originalNumber, reason: err.message || 'Send message failed' });
                                 return Promise.reject(err); // Rechazar para allSettled
                             });
                     } else {
                         console.warn(`   (${i+1}/${total}) Skipping ${chatId}: No content.`);
                         failedNumbers.push({ number: originalNumber, reason: "No content" });
                         sendPromise = Promise.reject(new Error("No content to send"));
                     }

                 } else {
                     console.warn(`   (${i+1}/${total}) Number ${numberOnly} (from ${originalNumber}) is not registered.`);
                     failedNumbers.push({ number: originalNumber, reason: "Not a valid WhatsApp number" });
                     sendPromise = Promise.reject(new Error("Not a valid WhatsApp number"));
                 }

            } catch (err) {
                console.error(`   (${i+1}/${total}) Failed operation for ${numberOnly} (from ${originalNumber}):`, err.message || err);
                failedNumbers.push({ number: originalNumber, chatIdAttempted: chatId, reason: err.message || 'Error during number check/send setup' });
                sendPromise = Promise.reject(err); // Rechazar para allSettled
            }

             sendPromises.push(sendPromise || Promise.resolve());

            if (i < numbersRaw.length - 1) {
                 console.log(`   (${i+1}/${total}) Waiting ${sendDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, sendDelay));
            }
        } // Fin del bucle for

        // Esperar a que todas las promesas de envío se completen
        const results = await Promise.allSettled(sendPromises);

        // Contar éxitos y fracasos DESPUÉS de que todo termine
        enviados = results.filter(r => r.status === 'fulfilled').length;
        fallidos = total - enviados;

        console.log(`✅✅ Finished sending process for ${userId}. Final count - Sent: ${enviados}, Failed: ${fallidos}`);
        if (failedNumbers.length > 0) {
            console.warn("   Failed numbers details:", failedNumbers);
        }

        // **Ahora es seguro eliminar el archivo temporal**
        if (mediaFile) {
            fs.unlink(mediaFile.path, (err) => {
                if (err) console.error(`   Error deleting uploaded file ${mediaFile.path} after sending:`, err);
                else console.log(`   Deleted uploaded file: ${mediaFile.path} after sending.`);
            });
        }
    })(); 


});

// --- Endpoint de Reportes (Placeholder) ---
console.log(">>> Registrando ruta /reports/:userId/:labelId/messages...");
app.get('/reports/:userId/:labelId/messages', async (req, res) => {
    const { userId, labelId } = req.params;
    console.log(`>>> RUTA /reports/<span class="math-inline">\{userId\}/</span>{labelId}/messages ALCANZADA`);
    const client = sessions[userId];

    if (!client || sessionStatus[userId] !== 'ready') {
        console.warn(`Session not ready for reports request (userId: ${userId})`);
        return res.status(400).json({ success: false, error: 'WhatsApp session not ready.' });
    }

    try {
        console.warn(`Workspaceing report data for label ${labelId} for user ${userId} - Not fully implemented`);

        let reportMessages = [];
         if (typeof client.getChatsByLabelId === 'function') {
            const chats = await client.getChatsByLabelId(labelId);
             for (const chat of chats) {
                 const messages = await chat.fetchMessages({ limit: 50 }); 
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
             }
         } else {
            console.warn("getChatsByLabelId not available for reports.");
         }


        res.json({ success: true, messages: reportMessages }); 

    } catch (error) {
        console.error(`Error generating report for label ${labelId}, userId: ${userId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to generate report: ' + error.message });
    }
});

// --- Inicio del Servidor ---
app.listen(port, () => {
    console.log(`WhatsApp Automator Server listening at http://localhost:${port}`);
});