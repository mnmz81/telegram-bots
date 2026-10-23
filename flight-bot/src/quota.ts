import { CONFIG } from './config';

export const needsConfirm = (left: number, cost: number, reserve: number = CONFIG.quotaReserve): boolean =>
  left - cost < reserve;
