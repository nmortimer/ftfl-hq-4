import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkCommissionerPassword } from './_lib/auth';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.COMMISSIONER_PASSWORD) {
    return res.status(500).json({ error: 'COMMISSIONER_PASSWORD is not set on the server' });
  }
  if (checkCommissionerPassword(req)) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: 'Wrong password' });
}
