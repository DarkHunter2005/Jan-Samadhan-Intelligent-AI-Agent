import express from 'express';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { users } from '../db/index.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { schemas, validate } from '../middleware/validate.js';

const router = express.Router();

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone,
  role: u.role, department: u.department, locality: u.locality,
});

router.post('/register', validate(schemas.register), (req, res) => {
  const { name, email, phone, password, locality } = req.body;

  if (users.byEmail(email)) {
    return res.status(409).json({ error: 'an account with this email already exists' });
  }

  const user = {
    id: `USR-${nanoid(10)}`,
    name,
    email,
    phone: phone ?? null,
    password_hash: bcrypt.hashSync(password, 10),
    role: 'citizen',            // self-registration always creates citizens
    department: null,
    locality: locality ?? null,
  };
  users.create(user);

  return res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', validate(schemas.login), (req, res) => {
  const { email, password } = req.body;
  const user = users.byEmail(email);

  // Same message and comparable timing for both failure modes, so the endpoint
  // cannot be used to enumerate registered email addresses.
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }

  return res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', authenticate(), (req, res) => {
  const user = users.byId(req.user.id);
  return res.json({ user: publicUser(user) });
});

export default router;
