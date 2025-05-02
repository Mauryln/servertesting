// server.js (CORREGIDO - Enfocado en /start-session)
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

console.log('Initializing WhatsApp Automator Server...');

// --- Endpoints de Gestión de Sesión ---

app.post('/start-session', express.json(), async (req, res) => {
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }
    console.log(`>>> POST /start-session request for userId: ${userId}`);

    // 1. Verificar si ya existe una sesión funcional o en proceso
    if (sessions[userId] && (sessionStatus[userId] === 'ready' || sessionStatus[userId] === 'initializing' || sessionStatus[userId] === 'needs_scan' || sessionStatus[userId] === 'authenticated')) {
        console.log(`<- Responding: Session already active or initializing for userId: ${userId} (Status: ${sessionStatus[userId]})`);
        return res.json({ success: true, message: `Session already ${sessionStatus[userId]}`, status: sessionStatus[userId] });
    }

    // 2. Limpiar sesión previa si existe y no está en un estado activo/inicializando
    if (sessions[userId]) {
        console.log(`   Cleaning up previous potentially stale session for ${userId}...`);
        try {
            // Intenta destruir sin esperar si la instancia parece válida
            if (sessions[userId].pupPage) { // Verificación simple
               sessions[userId].destroy().catch(err => console.warn(`   Ignoring error during async cleanup destroy for ${userId}: ${err.message}`));
            }
        } catch (err) {
            console.warn(`   Ignoring error during cleanup check for ${userId}: ${err.message}`);
        }
        delete sessions[userId];
        delete qrCodes[userId];
        // Limpiar la carpeta de sesión puede ser útil si la autenticación falla repetidamente
        /*
        const sessionFolderPath = path.join(dataPath, `session-${userId}`);
        fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
            if (err) console.error(`   Error removing session folder during cleanup for ${userId}:`, err);
            else console.log(`   Removed session folder during cleanup for ${userId}`);
        });
        */
    }

    // 3. Establecer estado inicial y preparar
    sessionStatus[userId] = 'initializing';
    qrCodes[userId] = null;
    console.log(`   Creating new WhatsApp client for userId: ${userId}`);

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
                '--log-level=3', // Reduce verbosidad de puppeteer
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
                // Flags experimentales que a veces ayudan:
                //'--single-process', // ¡Puede ser inestable!
            ],
            // executablePath: '/usr/bin/google-chrome-stable', // Ajustar si es necesario
        },
         webVersionCache: {
           type: 'local',
           path: path.join(__dirname, `.wwebjs_cache_${userId}`),
         }
    });

    // 4. Guardar referencia del cliente ANTES de inicializar para los listeners
    sessions[userId] = client;

    // 5. Configurar listeners ANTES de inicializar
    client.on('qr', (qr) => {
        console.log(`   QR Code generated for ${userId}. Scan it.`);
        qrCodes[userId] = qr;
        sessionStatus[userId] = 'needs_scan';
    });

    client.on('ready', () => {
        console.log(`✅ WhatsApp client is ready for ${userId}!`);
        sessionStatus[userId] = 'ready';
        qrCodes[userId] = null; // Limpia QR
    });

    client.on('authenticated', () => {
        console.log(`   Client authenticated for ${userId}`);
        sessionStatus[userId] = 'authenticated'; // Estado intermedio antes de 'ready'
        qrCodes[userId] = null; // Limpia QR
    });

    client.on('auth_failure', msg => {
        console.error(`❌ Authentication failure for ${userId}:`, msg);
        sessionStatus[userId] = 'auth_failure';
        const clientToDestroy = sessions[userId];
        delete sessions[userId];
        delete qrCodes[userId];
        if (clientToDestroy) clientToDestroy.destroy().catch(e => console.error("Error destroying on auth_failure", e));
        const sessionFolderPath = path.join(dataPath, `session-${userId}`);
        fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
            if (err) console.error(`   Error removing session folder on auth_failure for ${userId}:`, err);
            else console.log(`   Removed session folder on auth_failure for ${userId}`);
        });
    });

    client.on('disconnected', (reason) => {
        console.warn(`🔌 Client was logged out for ${userId}:`, reason);
        sessionStatus[userId] = 'disconnected';
        const clientToDestroy = sessions[userId];
        delete sessions[userId];
        delete qrCodes[userId];
         if (clientToDestroy) {
            clientToDestroy.destroy().catch(e => console.error("Error destroying on disconnect", e)).finally(() => {
                 const sessionFolderPath = path.join(dataPath, `session-${userId}`);
                 fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
                    if (err) console.error(`   Error removing session folder for disconnected ${userId}:`, err);
                    else console.log(`   Removed session folder for disconnected ${userId}`);
                 });
            });
        } else {
             const sessionFolderPath = path.join(dataPath, `session-${userId}`);
              fs.rm(sessionFolderPath, { recursive: true, force: true }, (err) => {
                 if (err) console.error(`   Error removing session folder for disconnected ${userId} (no client found):`, err);
                 else console.log(`   Removed session folder for disconnected ${userId} (no client found)`);
              });
        }
    });

    // 6. Intentar inicializar y ESPERAR el resultado antes de responder
    try {
        console.log(`   Attempting client.initialize() for ${userId}...`);
        await client.initialize();
        // Si llegamos aquí, initialize() se resolvió. El estado debería ser 'ready' o 'needs_scan'
        console.log(`   Client initialization promise resolved for ${userId}. Current status: ${sessionStatus[userId]}`);
        // Enviar respuesta de éxito AHORA, con el estado actual
        res.json({ success: true, message: 'Session initialization finished.', status: sessionStatus[userId] });
    } catch (err) {
        console.error(`❌ Error during client.initialize() for ${userId}:`, err);
        sessionStatus[userId] = 'init_error';
        const clientToDestroy = sessions[userId]; // Guardar referencia antes de borrar
        delete sessions[userId];
        delete qrCodes[userId];
         // Intentar destruir la instancia fallida
         if(clientToDestroy) clientToDestroy.destroy().catch(e => console.error("Error destroying failed client instance", e));

        // Enviar respuesta de error AHORA
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
    console.log(`>>> GET /session-status/${userId}. Tracked status: ${trackedStatus}`);

    if (client && typeof client.getState === 'function') {
        try {
            const state = await client.getState(); // getState() puede ser null si no está listo
            console.log(`   Client state for ${userId}: ${state}`);

            // Mapear estado del cliente a nuestro estado interno si es relevante
            if (state === 'CONNECTED') {
                if (trackedStatus !== 'ready') console.log(`   Updating tracked status to 'ready' for ${userId}`);
                sessionStatus[userId] = 'ready';
                qrCodes[userId] = null; // Clear QR on ready
                return res.json({ success: true, status: 'ready' });
            } else if (state === 'PAIRING') {
                 if (trackedStatus !== 'needs_scan') console.log(`   Updating tracked status to 'needs_scan' for ${userId}`);
                sessionStatus[userId] = 'needs_scan';
                // Keep QR code available if it exists
                return res.json({ success: true, status: 'needs_scan' });
            } else if (state === null || state === 'OPENING' || state === 'TIMEOUT') {
                // Si getState() es null/opening/timeout, confiamos más en nuestro estado rastreado
                // *A MENOS* que el estado rastreado sea inesperadamente 'ready' o 'disconnected'.
                if (trackedStatus === 'initializing' || trackedStatus === 'authenticated' || trackedStatus === 'needs_scan') {
                    console.log(`   getState is '${state}', but tracked status is '${trackedStatus}'. Responding with tracked status.`);
                    return res.json({ success: true, status: trackedStatus });
                } else {
                    // Si el estado rastreado era 'ready' o 'disconnected', pero getState() es null/opening,
                    // probablemente significa que está intentando reconectar o iniciar de nuevo. Marcar como initializing.
                    // ***CAMBIO CLAVE: No revertir a disconnected aquí***
                    console.warn(`   Handling intermediate state for ${userId}: getState is '${state}', tracked status was '${trackedStatus}'. Setting to 'initializing'.`);
                    sessionStatus[userId] = 'initializing'; // O mantener 'needs_scan' si ya estaba así? Probemos initializing.
                    return res.json({ success: true, status: 'initializing' });
                }
            } else {
                // Manejar otros estados como 'CONFLICT', etc. Tratar como desconectado.
                console.warn(`   Unhandled client state '${state}' for ${userId}. Setting to 'disconnected'.`);
                 if (trackedStatus !== 'disconnected' && trackedStatus !== 'no_session') {
                     // Limpiar sesión si no estaba ya marcada como desconectada/inexistente
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
            // Si getState falla, usar estado rastreado pero indicar problema potencial
             return res.json({ success: true, status: trackedStatus, error: 'Could not determine exact client state.' });
        }
    } else {
        // No hay instancia de cliente, responder con estado rastreado (probablemente 'no_session', 'disconnected', 'init_error', etc.)
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
    console.log(`>>> GET /get-qr/${userId} request. Current Status: ${status}, QR available: ${!!qr}`);

    if (status === 'ready') {
        console.log(`<- Responding QR: Session ready for ${userId}`);
        return res.json({ success: true, qrCode: null, status: 'ready', message: 'Client already ready' });
    } else if (qr && status === 'needs_scan') {
        console.log(`<- Responding QR: Sending QR code for ${userId}`);
        return res.json({ success: true, qrCode: qr, status: 'needs_scan' });
    } else if (status === 'initializing' || status === 'authenticated') {
        // Si el QR existe durante 'authenticated' (puede pasar brevemente), enviarlo.
        if(qr && status === 'authenticated') {
             console.log(`<- Responding QR: Sending QR code for authenticated user ${userId}`);
             return res.json({ success: true, qrCode: qr, status: 'authenticated' });
        }
        // Si no hay QR o está inicializando, esperar.
        console.log(`<- Responding QR: Not generated yet or already authenticated (no QR) for ${userId} (Status: ${status})`);
        return res.status(202).json({ success: false, status: status, error: 'QR code not generated yet or session is authenticating/ready.' });
    } else {
        // Si el estado es auth_failure, init_error, disconnected, or no_session
        console.log(`<- Responding QR: No active session or QR for userId: ${userId}, Status: ${status}`);
        // Devolver 404 para indicar que no hay QR disponible en este estado
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
        sessionStatus[userId] = 'disconnected'; // Marcar como desconectado inmediatamente
        delete qrCodes[userId]; // Limpiar QR si existiera

        try {
             // Solo intentar logout si el cliente parece estar en un estado que lo permita
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
                 // Siempre intentar destruir después de logout o si no se hizo logout
                 if (sessions[userId] && typeof sessions[userId].destroy === 'function') { // Comprobar de nuevo por si acaso
                     await sessions[userId].destroy();
                     console.log(`   Client instance destroyed for ${userId}`);
                 }
             } catch (destroyError) {
                 console.error(`   Error destroying client for ${userId} during close:`, destroyError);
             } finally {
                 // Asegurarse de limpiar estado y carpeta
                 delete sessions[userId];
                 sessionStatus[userId] = 'no_session'; // Finalizar en no_session
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
        sessionStatus[userId] = 'no_session'; // Asegurar estado correcto
        res.status(404).json({ success: false, error: 'No active session found.', status: 'no_session' });
    }
});


// --- Endpoints de Obtención de Datos (mantener igual que tu versión original) ---

app.get('/labels/:userId', async (req, res) => {
    // ... (tu código original para /labels/:userId) ...
    const userId = req.params.userId;
    console.log(`>>> GET /labels/${userId} request`);
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
        console.log(`<- Responding: Labels fetched successfully for ${userId}:`, labels.length);
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
    // ... (tu código original para /labels/:userId/:labelId/chats) ...
     const { userId, labelId } = req.params;
    console.log(`>>> GET /labels/${userId}/${labelId}/chats request`);
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
    // ... (tu código original para /groups/:userId) ...
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
                 // participants: chat.participants ? chat.participants.length : 'N/A' // Puede ser lento
             }));
         console.log(`<- Responding: Groups fetched for ${userId}:`, groups.length);
         res.json({ success: true, groups: groups });
     } catch (error) {
         console.error(`Error fetching groups for ${userId}:`, error);
         res.status(500).json({ success: false, error: 'Failed to fetch groups: ' + error.message });
     }
});

app.get('/groups/:userId/:groupId/participants', async (req, res) => {
    // ... (tu código original para /groups/:userId/:groupId/participants) ...
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

        // Asegurarse de que los participantes están cargados.
        // groupChat.participants puede no estar poblado inicialmente.
        // groupChat.fetchParticipants() podría ser necesario, pero es asíncrono y puede tardar.
        // Por simplicidad, intentamos acceder directamente, pero esto puede fallar a veces.
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
                 // Continuar sin participantes si fetchParticipants falla
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


// --- Endpoint de Envío de Mensajes (mantener el corregido anteriormente) ---
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
    })(); // Fin de la función async auto-ejecutable

    // La respuesta HTTP ya se envió antes.
});

// --- Endpoint de Reportes (mantener igual que tu versión original) ---
app.get('/reports/:userId/:labelId/messages', async (req, res) => {
    // ... (tu código original para /reports/:userId/:labelId/messages) ...
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
                     const messages = await chat.fetchMessages({ limit: 50 }); // Limitar historial
                     messages.forEach(msg => {
                         if (msg.fromMe) {
                             reportMessages.push({
                                 number: chat.id.user,
                                 body: msg.body || (msg.hasMedia ? '[Media]' : ''),
                                 timestamp: msg.timestamp,
                                 ack: msg.ack,
                                 response: null // Lógica de respuesta pendiente
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


// --- Inicio del Servidor ---
app.listen(port, ipAddress, () => {
    console.log(`🚀 WhatsApp Automator Server listening at http://${ipAddress}:${port}`);
});