const raw = String(import.meta.env.VITE_API_URL || '').trim();

export const API_BASE = raw || (import.meta.env.DEV ? 'http://localhost:5002' : '');
export const IS_DEV = import.meta.env.DEV;
