import { z } from 'zod';

/** Validates req[source] against a zod schema, replacing it with the parsed value. */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: 'validation failed',
        details: result.error.issues.map((i) => ({
          field: i.path.join('.') || '(root)',
          message: i.message,
        })),
      });
    }
    if (source === 'query') req.validatedQuery = result.data;
    else req[source] = result.data;
    return next();
  };
}

export const schemas = {
  register: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().min(6).max(20).optional(),
    password: z.string().min(8, 'password must be at least 8 characters').max(200),
    locality: z.string().trim().max(120).optional(),
  }),

  login: z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  }),

  createComplaint: z.object({
    text: z.string().trim().min(10, 'please describe the issue in at least 10 characters').max(5000),
    locality: z.string().trim().max(120).optional(),
    address: z.string().trim().max(300).optional(),
    language: z.string().trim().max(12).optional(),
    citizen_name: z.string().trim().max(120).optional(),
    citizen_phone: z.string().trim().max(20).optional(),
  }),

  updateStatus: z.object({
    status: z.enum(['submitted', 'routed', 'in_progress', 'resolved', 'rejected', 'duplicate', 'reopened']),
    note: z.string().trim().max(2000).optional(),
  }),

  reassign: z.object({
    department_code: z.string().trim().min(2).max(12).optional(),
    assigned_to: z.string().trim().max(40).nullable().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    note: z.string().trim().max(2000).optional(),
  }),

  feedback: z.object({
    rating: z.coerce.number().int().min(1).max(5),
    note: z.string().trim().max(1000).optional(),
  }),

  listQuery: z.object({
    status: z.string().optional(),
    department: z.string().optional(),
    priority: z.string().optional(),
    category: z.string().optional(),
    locality: z.string().optional(),
    assignedTo: z.string().optional(),
    needsReview: z.enum(['0', '1']).optional(),
    overdue: z.enum(['0', '1']).optional(),
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(['created_at', 'priority_score', 'due_at', 'updated_at']).default('created_at'),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).default('DESC'),
  }),
};
