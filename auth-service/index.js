const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const app    = express();
const PORT   = process.env.AUTH_PORT || 4005;

// Must match the JWT_SECRET used in the API Gateway
const SECRET = process.env.JWT_SECRET || 'AeroLinkSecureKey2026!';

app.use(express.json());

// ─── In-memory user store ────────────────────────────────────────────────────
// Pre-seeded accounts for demo. In production replace with Aurora/DynamoDB.
const users = [
    { id: 1, email: 'admin@aerolink.com', password: bcrypt.hashSync('admin123', 10), role: 'admin'  },
    { id: 2, email: 'staff@aerolink.com', password: bcrypt.hashSync('staff123', 10), role: 'staff'  },
    { id: 3, email: 'user@aerolink.com',  password: bcrypt.hashSync('user123',  10), role: 'user'   },
];

// ─── Health check (used by Docker Compose healthcheck + gateway depends_on) ──
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'auth-service', port: PORT });
});

const authRouter = express.Router();

// ─── POST /login ────────────────────────────────────────────────────────
authRouter.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email and password required' });

    const user = users.find(u => u.email === email);
    if (!user || !bcrypt.compareSync(password, user.password))
        return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        SECRET,
        { expiresIn: '8h', issuer: 'AeroLink-Auth' }
    );

    console.log(JSON.stringify({ level: 'INFO', event: 'LOGIN', email: user.email, role: user.role }));

    res.json({
        message: 'Authentication successful',
        token,
        role:    user.role,
        email:   user.email,
    });
});

// ─── POST /register ─────────────────────────────────────────────────────
authRouter.post('/register', (req, res) => {
    const { email, password, role = 'user' } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email and password required' });

    if (users.find(u => u.email === email))
        return res.status(409).json({ error: 'Email already registered' });

    // Only allow valid roles to be self-assigned
    const allowedRoles = ['user', 'staff'];
    const assignedRole  = allowedRoles.includes(role) ? role : 'user';

    const newUser = {
        id:       users.length + 1,
        email,
        password: bcrypt.hashSync(password, 10),
        role:     assignedRole,
    };
    users.push(newUser);

    const token = jwt.sign(
        { id: newUser.id, email: newUser.email, role: newUser.role },
        SECRET,
        { expiresIn: '8h', issuer: 'AeroLink-Auth' }
    );

    console.log(JSON.stringify({ level: 'INFO', event: 'REGISTER', email: newUser.email, role: newUser.role }));

    res.status(201).json({
        message: 'Registration successful',
        token,
        role:    newUser.role,
        email:   newUser.email,
    });
});

// ─── GET /verify ────────────────────────────────────────────────────────
// Called internally by the gateway to validate tokens without re-implementing
// JWT logic in every microservice.
authRouter.get('/verify', (req, res) => {
    const authHeader = req.headers['authorization'];
    const token      = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ valid: false, error: 'No token provided' });

    try {
        const decoded = jwt.verify(token, SECRET);
        res.json({ valid: true, user: decoded });
    } catch (err) {
        res.status(401).json({ valid: false, error: 'Invalid or expired token' });
    }
});

app.use('/auth', authRouter);
app.use('/api/auth', authRouter);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({
        level:   'INFO',
        service: 'auth-service',
        port:    PORT,
        status:  'started',
    }));
});