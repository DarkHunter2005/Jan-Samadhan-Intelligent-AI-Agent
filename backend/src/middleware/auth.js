import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { users } from '../db/index.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, department: user.department ?? null },
    config.jwtSecret,
    { expiresIn: config.jwtExpiry }
  );
}

/** Populates req.user when a valid bearer token is present. */
export function authenticate(required = true) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      if (required) return res.status(401).json({ error: 'authentication required' });
      return next();
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = users.byId(payload.sub);
      if (!user) return res.status(401).json({ error: 'user no longer exists' });
      req.user = { id: user.id, role: user.role, name: user.name,
                   email: user.email, department: user.department };
      return next();
    } catch {
      if (required) return res.status(401).json({ error: 'invalid or expired token' });
      return next();
    }
  };
}

/** Restricts a route to the given roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `requires role: ${roles.join(' or ')}` });
    }
    return next();
  };
}

/** Officers may only touch complaints belonging to their own department. */
export function assertDepartmentAccess(user, complaint) {
  if (user.role === 'admin') return true;
  if (user.role === 'officer') return complaint.department_code === user.department;
  return complaint.user_id === user.id;
}
