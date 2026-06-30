require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const AWS = require('aws-sdk');

// DigitalOcean Spaces Credentials (extracted from Revoo configuration)
const DO_SPACES_KEY = process.env.DO_SPACES_KEY || "DO00U72P47BHHPDLVRRT";
const DO_SPACES_SECRET = process.env.DO_SPACES_SECRET || "HXp2L4tWP0jrcD2S96s83nlFXP8jh4CFHmiMt0BZ7ew";
const DO_BUCKET = process.env.DO_BUCKET || "appzest";
const DO_REGION = process.env.DO_REGION || "blr1";
const DO_ENDPOINT = process.env.DO_ENDPOINT || "blr1.digitaloceanspaces.com";

const s3 = new AWS.S3({
    endpoint: new AWS.Endpoint(DO_ENDPOINT),
    accessKeyId: DO_SPACES_KEY,
    secretAccessKey: DO_SPACES_SECRET,
    region: DO_REGION,
    signatureVersion: "v4",
});

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Serve static frontend files and uploads folder
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_DIR));

// Setup Multer memory storage configuration (required for Vercel/Spaces)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// MySQL Database Connection Pool with SSL config
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '25060'),
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==================== APP API ENDPOINTS ====================

// Endpoint: Get App Configuration by App ID
app.get('/api/app', async (req, res) => {
    const appId = req.query.app_id || '4';
    try {
        const [rows] = await pool.query('SELECT * FROM apps WHERE app_id = ?', [appId]);
        if (rows.length > 0) {
            return res.json({ success: true, app: rows[0] });
        } else {
            return res.json({
                success: true,
                app: {
                    app_id: appId,
                    app_name: 'Offrix Offerwall',
                    conversion_rate: 100,
                    coin_icon_url: 'https://img.icons8.com/color/48/gold-ingress-decal.png'
                }
            });
        }
    } catch (err) {
        console.error('Error fetching app configuration:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: List all Apps (Admin Panel)
app.get('/api/admin/apps', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM apps ORDER BY id DESC');
        return res.json({ success: true, apps: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Create/Update App configuration (Admin Panel)
app.post('/api/admin/apps', async (req, res) => {
    const { app_id, app_name, conversion_rate, coin_icon_url } = req.body;
    if (!app_id || !app_name) {
        return res.status(400).json({ success: false, message: 'App ID and App Name are required' });
    }

    try {
        const [existing] = await pool.query('SELECT * FROM apps WHERE app_id = ?', [app_id]);
        if (existing.length > 0) {
            await pool.query(
                'UPDATE apps SET app_name = ?, conversion_rate = ?, coin_icon_url = ? WHERE app_id = ?',
                [app_name, parseInt(conversion_rate || '100'), coin_icon_url, app_id]
            );
            return res.json({ success: true, message: 'App updated successfully' });
        } else {
            await pool.query(
                'INSERT INTO apps (app_id, app_name, conversion_rate, coin_icon_url) VALUES (?, ?, ?, ?)',
                [app_id, app_name, parseInt(conversion_rate || '100'), coin_icon_url]
            );
            return res.json({ success: true, message: 'App created successfully' });
        }
    } catch (err) {
        console.error('Error saving app:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});


// ==================== OFFERS / CAMPAIGNS ENDPOINTS ====================

// Endpoint: Fetch active offers (calculated dynamically based on app_id)
app.get('/api/offers', async (req, res) => {
    const appId = req.query.app_id || '4';
    try {
        const [appRows] = await pool.query('SELECT conversion_rate FROM apps WHERE app_id = ?', [appId]);
        const rate = appRows.length > 0 ? appRows[0].conversion_rate : 100;

        const [offers] = await pool.query("SELECT * FROM offers WHERE status = 'active' ORDER BY payout_rupees DESC");

        const mappedOffers = offers.map(offer => {
            const points = Math.round(parseFloat(offer.payout_rupees || 0.00) * rate);
            return {
                ...offer,
                points: points
            };
        });

        return res.json({ success: true, offers: mappedOffers });
    } catch (err) {
        console.error('Error fetching offers:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: List all offers in Rupees (Admin Panel)
app.get('/api/admin/offers', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM offers ORDER BY id DESC');
        return res.json({ success: true, offers: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Create/Update Offer (Admin Panel)
app.post('/api/admin/offers', async (req, res) => {
    const { id, title, description, payout_rupees, image_url, offer_url, provider, status, campaign_type, steps, review_text } = req.body;
    if (!title || !offer_url) {
        return res.status(400).json({ success: false, message: 'Title and Offer URL are required' });
    }

    const payoutVal = parseFloat(payout_rupees || 0.00);

    try {
        if (id) {
            await pool.query(
                'UPDATE offers SET title = ?, description = ?, payout_rupees = ?, image_url = ?, offer_url = ?, provider = ?, status = ?, campaign_type = ?, steps = ?, review_text = ? WHERE id = ?',
                [title, description, payoutVal, image_url, offer_url, provider || 'Offrix', status || 'active', campaign_type || 'game', steps || '', review_text || '', id]
            );
            return res.json({ success: true, message: 'Offer updated successfully' });
        } else {
            await pool.query(
                'INSERT INTO offers (title, description, payout_rupees, image_url, offer_url, provider, status, campaign_type, steps, review_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [title, description, payoutVal, image_url, offer_url, provider || 'Offrix', status || 'active', campaign_type || 'game', steps || '', review_text || '']
            );
            return res.json({ success: true, message: 'Offer created successfully' });
        }
    } catch (err) {
        console.error('Error saving offer:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});


// ==================== USER / STATUS ENDPOINTS ====================

// Endpoint: Get or initialize user details
app.get('/api/user', async (req, res) => {
    const userId = req.query.user_id || 'test_user';
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE user_id = ?', [userId]);
        if (rows.length > 0) {
            return res.json({ success: true, user: rows[0] });
        } else {
            await pool.query('INSERT INTO users (user_id, balance, total_earned) VALUES (?, 0, 0)', [userId]);
            const [newRows] = await pool.query('SELECT * FROM users WHERE user_id = ?', [userId]);
            return res.json({ success: true, user: newRows[0] });
        }
    } catch (err) {
        console.error('Error fetching user:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Get user completions
app.get('/api/status', async (req, res) => {
    const userId = req.query.user_id || 'test_user';
    try {
        const [rows] = await pool.query('SELECT * FROM conversions WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        return res.json({ success: true, status: rows });
    } catch (err) {
        console.error('Error fetching completions status:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Postback / Conversion completion
app.get('/api/postback', async (req, res) => {
    const { user_id, offer_name, payout, app_id, transaction_id } = req.query;
    
    if (!user_id || !offer_name) {
        return res.status(400).json({ success: false, message: 'Missing parameters user_id or offer_name' });
    }

    const appId = app_id || '4';
    const txId = transaction_id || `tx_${Date.now()}`;

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [appRows] = await conn.query('SELECT conversion_rate FROM apps WHERE app_id = ?', [appId]);
        const rate = appRows.length > 0 ? appRows[0].conversion_rate : 100;

        let pointsVal = 0;
        if (payout) {
            pointsVal = Math.round(parseFloat(payout) * rate);
        } else if (req.query.points) {
            pointsVal = parseInt(req.query.points);
        } else {
            await conn.rollback();
            return res.status(400).json({ success: false, message: 'Missing parameter payout or points' });
        }

        const [userRows] = await conn.query('SELECT * FROM users WHERE user_id = ?', [user_id]);
        if (userRows.length === 0) {
            await conn.query('INSERT INTO users (user_id, balance, total_earned) VALUES (?, 0, 0)', [user_id]);
        }

        const [txRows] = await conn.query('SELECT * FROM conversions WHERE transaction_id = ?', [txId]);
        if (txRows.length > 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, message: 'Duplicate transaction ID' });
        }

        await conn.query(
            'INSERT INTO conversions (user_id, offer_name, points, status, transaction_id) VALUES (?, ?, ?, ?, ?)',
            [user_id, offer_name, pointsVal, 'completed', txId]
        );

        await conn.query(
            'UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?',
            [pointsVal, pointsVal, user_id]
        );

        await conn.commit();
        return res.json({ success: true, message: `Successfully credited ${pointsVal} coins to ${user_id}`, transaction_id: txId });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Error handling postback:', err);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});


// ==================== REVIEW CAMPAIGNS SUBMISSION & ADMIN MANAGEMENT ====================

// Endpoint: User submits campaign review (Multipart Form: text fields + screenshot file)
app.post('/api/review-submit', upload.single('screenshot'), async (req, res) => {
    const { user_id, offer_id, app_id } = req.body;

    if (!user_id || !offer_id) {
        return res.status(400).json({ success: false, message: 'Missing user_id or offer_id' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Verification screenshot image file is required' });
    }

    const appId = app_id || '4';

    try {
        const file = req.file;
        const ext = path.extname(file.originalname) || ".jpg";
        const key = `offrix/reviews/${appId}/${Date.now()}_${Math.round(Math.random() * 1e5)}${ext}`;

        const uploadParams = {
            Bucket: DO_BUCKET,
            Key: key,
            Body: file.buffer,
            ACL: "public-read",
            ContentType: file.mimetype || "image/jpeg",
        };

        const uploadResult = await s3.upload(uploadParams).promise();
        const screenshotUrl = uploadResult.Location;
        // Fetch Offer details to calculate points and get its title
        const [offers] = await pool.query('SELECT title, payout_rupees FROM offers WHERE id = ?', [offer_id]);
        if (offers.length === 0) {
            return res.status(404).json({ success: false, message: 'Offer not found' });
        }
        const offer = offers[0];

        const [appRows] = await pool.query('SELECT conversion_rate FROM apps WHERE app_id = ?', [appId]);
        const rate = appRows.length > 0 ? appRows[0].conversion_rate : 100;
        const points = Math.round(parseFloat(offer.payout_rupees || 0) * rate);

        // Duplicate Check for pending or completed conversion of this user and campaign
        const [existing] = await pool.query(
            "SELECT id FROM conversions WHERE user_id = ? AND campaign_id = ? AND status IN ('pending', 'completed')",
            [user_id, offer_id]
        );
        if (existing.length > 0) {
            return res.status(409).json({ success: false, message: 'You have already submitted a review for this task' });
        }

        const transactionId = `rev_${Date.now()}_${Math.round(Math.random() * 1000)}`;

        // Insert pending conversion log
        await pool.query(
            'INSERT INTO conversions (user_id, offer_name, points, status, transaction_id, campaign_id, review_screenshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user_id, offer.title, points, 'pending', transactionId, offer_id, screenshotUrl]
        );

        return res.status(201).json({ success: true, message: 'Review submitted successfully. Reward will be added once approved.', screenshot: screenshotUrl });
    } catch (err) {
        console.error('Review submit error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Admin Panel list all conversions (to review screenshots)
app.get('/api/admin/conversions', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM conversions ORDER BY id DESC');
        return res.json({ success: true, conversions: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Admin Panel update conversion status (Approve or Reject review submissions)
app.post('/api/admin/conversions/update', async (req, res) => {
    const { id, status } = req.body; // status must be 'completed' or 'rejected'
    if (!id || !['completed', 'rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Valid ID and status (completed/rejected) required' });
    }

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 1. Fetch conversion details
        const [convRows] = await conn.query('SELECT * FROM conversions WHERE id = ?', [id]);
        if (convRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'Conversion record not found' });
        }
        const conversion = convRows[0];

        if (conversion.status !== 'pending') {
            await conn.rollback();
            return res.status(400).json({ success: false, message: 'Conversion is already processed' });
        }

        // 2. Update conversion status
        await conn.query('UPDATE conversions SET status = ? WHERE id = ?', [status, id]);

        // 3. If approved ('completed'), credit points to user
        if (status === 'completed') {
            const pointsVal = parseInt(conversion.points);
            
            // Ensure user exists
            const [userRows] = await conn.query('SELECT * FROM users WHERE user_id = ?', [conversion.user_id]);
            if (userRows.length === 0) {
                await conn.query('INSERT INTO users (user_id, balance, total_earned) VALUES (?, 0, 0)', [conversion.user_id]);
            }

            // Credit balance
            await conn.query(
                'UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?',
                [pointsVal, pointsVal, conversion.user_id]
            );
        }

        await conn.commit();
        return res.json({ success: true, message: `Conversion successfully marked as ${status}` });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Error updating conversion:', err);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});


// Fallback to index.html for frontend routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server conditionally (Vercel handles listen on exports)
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`========================================`);
        console.log(`Offrix Server is running on port ${PORT}`);
        console.log(`Local: http://localhost:${PORT}`);
        console.log(`========================================`);
    });
}

module.exports = app;
