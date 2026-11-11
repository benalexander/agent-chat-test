/** Request-body schemas shared by the app debug routes (agent.ts) and the admin API (admin.ts). */
import { z } from 'zod';
import { isExpoPushToken } from './push';

export const DonationSchema = z.object({
  amount: z.number().positive().max(1_000_000),
  donorName: z.string().max(100).optional(),
  message: z.string().max(1000).optional(),
});
export type DonationInput = z.infer<typeof DonationSchema>;

export const MilestoneSchema = z.object({
  percent: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]),
});
export type MilestonePercent = z.infer<typeof MilestoneSchema>['percent'];

export const ForceSchema = z.object({
  trigger: z.enum(['donation', 'milestone', 'inactivity', 'checkin', 'manual']).optional(),
});

/** UpdateCampaignRequest (shared/src/admin.ts). */
export const UpdateCampaignSchema = z
  .object({
    raised: z.number().int().min(0).max(1_000_000_000).optional(),
    target: z.number().int().positive().max(1_000_000_000).optional(),
    donorCount: z.number().int().min(0).max(10_000_000).optional(),
    endsAt: z.number().int().positive().optional(),
  })
  .strict();
export type CampaignPatch = z.infer<typeof UpdateCampaignSchema>;

/** PushTokenRequest (shared/src/protocol.ts). */
export const PushTokenSchema = z.object({
  token: z.string().refine(isExpoPushToken, 'not an Expo push token'),
});

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
